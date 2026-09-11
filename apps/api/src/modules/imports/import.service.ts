import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ImportRowStatus, ImportStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { detectColumnMapping, normalizeRawRow, NormalizedRow } from "./field-mapping";
import { detectSourceType, parseFile } from "./file-parser";
import { validateRow } from "./validate-row";
import { UpdateImportRowDto } from "./dto/update-import-row.dto";

const MAX_ROWS = 2000;

@Injectable()
export class ImportService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    return this.prisma.importJob.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
  }

  async findOne(jobId: string, businessId: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, businessId } });
    if (!job) throw new NotFoundException("Import job not found.");
    return job;
  }

  async findRows(jobId: string, businessId: string) {
    await this.findOne(jobId, businessId);
    return this.prisma.importRow.findMany({ where: { importJobId: jobId }, orderBy: { rowNumber: "asc" } });
  }

  /** Parses, maps and validates an uploaded catalogue file, persisting one ImportRow per source row. */
  async create(businessId: string, file: Express.Multer.File, createdById: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    if (!file) throw new BadRequestException("No file was uploaded.");

    const sourceType = detectSourceType(file.originalname, file.mimetype);
    const rawRows = parseFile(file.buffer, sourceType);
    if (rawRows.length === 0) throw new BadRequestException("No rows were detected in the uploaded file.");
    if (rawRows.length > MAX_ROWS) {
      throw new BadRequestException(`This file has ${rawRows.length} rows, which exceeds the ${MAX_ROWS}-row limit for a single import.`);
    }

    const headers = Object.keys(rawRows[0]);
    const columnMapping = detectColumnMapping(headers);

    const job = await this.prisma.importJob.create({
      data: { businessId, filename: file.originalname, sourceType, status: ImportStatus.PENDING, rowsDetected: rawRows.length, columnMapping: columnMapping as object, createdById },
    });

    const normalizedRows = rawRows.map((raw) => normalizeRawRow(raw, columnMapping));
    await this.persistAndValidateRows(job.id, businessId, rawRows, normalizedRows);

    return this.findOne(job.id, businessId);
  }

  /** Re-runs validation across every row in the job (used after uploading, and after a merchant edits a row). */
  private async persistAndValidateRows(jobId: string, businessId: string, rawRows: Record<string, unknown>[], normalizedRows: NormalizedRow[]) {
    const { existingBySku, existingNamesLower } = await this.loadExistingCatalogue(businessId);
    const skuCounts = new Map<string, number>();
    for (const row of normalizedRows) {
      if (row.sku) skuCounts.set(row.sku.toLowerCase(), (skuCounts.get(row.sku.toLowerCase()) ?? 0) + 1);
    }

    let rowsReady = 0, rowsWarning = 0, rowsError = 0;
    const data = normalizedRows.map((normalized, i) => {
      const result = validateRow(normalized, {
        duplicateSkuInFile: !!normalized.sku && (skuCounts.get(normalized.sku.toLowerCase()) ?? 0) > 1,
        existingBySku, existingNamesLower,
      });
      if (result.status === "READY") rowsReady++;
      else if (result.status === "WARNING") rowsWarning++;
      else rowsError++;
      return {
        importJobId: jobId,
        rowNumber: i + 1,
        rawData: rawRows[i] as object,
        normalizedData: normalized as object,
        status: result.status as ImportRowStatus,
        validationErrors: result.errors as object,
        matchedProductId: result.matchedProductId,
        action: result.action,
      };
    });

    await this.prisma.importRow.createMany({ data });
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: ImportStatus.READY_FOR_REVIEW, rowsReady, rowsWarning, rowsError } });
  }

  private async loadExistingCatalogue(businessId: string) {
    const existingVariants = await this.prisma.variant.findMany({ where: { businessId, sku: { not: null } }, select: { sku: true, productId: true } });
    const existingBySku = new Map(existingVariants.filter((v) => v.sku).map((v) => [v.sku!.toLowerCase(), { sku: v.sku!, productId: v.productId }]));
    const existingProducts = await this.prisma.product.findMany({ where: { businessId }, select: { name: true } });
    const existingNamesLower = new Set(existingProducts.map((p) => p.name.trim().toLowerCase()));
    return { existingBySku, existingNamesLower };
  }

  /** Merchant edits/corrects a single row on the review screen, then it's re-validated against the whole job. */
  async updateRow(jobId: string, rowId: string, businessId: string, input: UpdateImportRowDto) {
    const job = await this.findOne(jobId, businessId);
    if (job.status !== ImportStatus.READY_FOR_REVIEW) throw new BadRequestException(`Import is ${job.status.toLowerCase()} and can no longer be edited.`);
    const row = await this.prisma.importRow.findFirst({ where: { id: rowId, importJobId: jobId } });
    if (!row) throw new NotFoundException("Import row not found.");

    const mergedNormalized: NormalizedRow = { ...(row.normalizedData as NormalizedRow), ...(input.normalizedData as NormalizedRow ?? {}) };
    const allRows = await this.prisma.importRow.findMany({ where: { importJobId: jobId }, orderBy: { rowNumber: "asc" } });
    const { existingBySku, existingNamesLower } = await this.loadExistingCatalogue(businessId);

    const skuCounts = new Map<string, number>();
    for (const r of allRows) {
      const n = r.id === rowId ? mergedNormalized : (r.normalizedData as NormalizedRow);
      if (n?.sku) skuCounts.set(n.sku.toLowerCase(), (skuCounts.get(n.sku.toLowerCase()) ?? 0) + 1);
    }

    let rowsReady = 0, rowsWarning = 0, rowsError = 0;
    for (const r of allRows) {
      const n = r.id === rowId ? mergedNormalized : (r.normalizedData as NormalizedRow);
      const result = validateRow(n, { duplicateSkuInFile: !!n?.sku && (skuCounts.get(n.sku.toLowerCase()) ?? 0) > 1, existingBySku, existingNamesLower });
      if (result.status === "READY") rowsReady++;
      else if (result.status === "WARNING") rowsWarning++;
      else rowsError++;
      await this.prisma.importRow.update({
        where: { id: r.id },
        data: {
          normalizedData: n as object,
          status: result.status as ImportRowStatus,
          validationErrors: result.errors as object,
          matchedProductId: result.matchedProductId,
          action: r.id === rowId && input.action ? input.action : result.action,
        },
      });
    }
    await this.prisma.importJob.update({ where: { id: jobId }, data: { rowsReady, rowsWarning, rowsError } });
    return this.prisma.importRow.findUnique({ where: { id: rowId } });
  }

  /** Creates/updates real Product+Variant records for every non-blocked row. Error rows are never silently inserted. */
  async commit(jobId: string, businessId: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, businessId }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
    if (!job) throw new NotFoundException("Import job not found.");
    if (job.status !== ImportStatus.READY_FOR_REVIEW) throw new BadRequestException(`Import is ${job.status.toLowerCase()} and cannot be committed.`);

    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: ImportStatus.COMMITTING } });

    // rows sharing the same (case-insensitive) product name become variants of ONE product — e.g. the same
    // t-shirt uploaded as 4 rows for sizes S/M/L/XL — rather than 4 separate duplicate products.
    const eligibleRows = job.rows.filter((r) => r.status !== ImportRowStatus.ERROR && r.action !== "SKIP");
    const skipped = job.rows.length - eligibleRows.length;
    const groups = new Map<string, typeof eligibleRows>();
    for (const row of eligibleRows) {
      const key = ((row.normalizedData as NormalizedRow).name ?? "").trim().toLowerCase();
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }

    let created = 0, updated = 0;
    for (const groupRows of groups.values()) {
      const matchedProductId = groupRows.find((r) => r.action === "UPDATE" && r.matchedProductId)?.matchedProductId ?? null;
      const first = groupRows[0].normalizedData as NormalizedRow;

      let productId: string;
      if (matchedProductId) {
        await this.prisma.product.update({
          where: { id: matchedProductId },
          data: {
            name: first.name ?? undefined,
            description: first.description ?? undefined,
            category: first.category ?? undefined,
            brand: first.brand ?? undefined,
          },
        });
        productId = matchedProductId;
        updated++;
      } else {
        const product = await this.prisma.product.create({
          data: {
            businessId,
            name: first.name!,
            description: first.description ?? null,
            category: first.category ?? null,
            brand: first.brand ?? null,
            source: "IMPORT",
          },
        });
        productId = product.id;
        created++;
      }

      for (const row of groupRows) {
        const n = row.normalizedData as NormalizedRow;
        const attributes = n.color || n.size ? { ...(n.color ? { color: n.color } : {}), ...(n.size ? { size: n.size } : {}) } : null;

        if (row.action === "UPDATE" && row.matchedProductId) {
          const variant = await this.prisma.variant.findFirst({ where: { businessId, productId: row.matchedProductId } });
          if (variant) {
            await this.prisma.variant.update({
              where: { id: variant.id },
              data: {
                price: n.price, currency: n.currency ?? variant.currency,
                inventory: n.inventory ?? variant.inventory,
                compareAtPrice: n.compareAtPrice ?? variant.compareAtPrice,
                costPrice: n.costPrice ?? variant.costPrice,
                barcode: n.barcode ?? variant.barcode,
                weight: n.weight ?? variant.weight,
                length: n.length ?? variant.length, width: n.width ?? variant.width, height: n.height ?? variant.height,
                attributes: (attributes ?? variant.attributes ?? Prisma.JsonNull) as object,
              },
            });
          }
        } else {
          await this.prisma.variant.create({
            data: {
              businessId, productId,
              sku: n.sku ?? null,
              price: n.price!,
              currency: n.currency ?? "INR",
              inventory: n.inventory ?? null,
              barcode: n.barcode ?? null,
              compareAtPrice: n.compareAtPrice ?? null,
              costPrice: n.costPrice ?? null,
              weight: n.weight ?? null,
              length: n.length ?? null, width: n.width ?? null, height: n.height ?? null,
              attributes: (attributes ?? Prisma.JsonNull) as object,
            },
          });
        }
        await this.prisma.importRow.update({ where: { id: row.id }, data: { committedProductId: productId } });
      }
    }

    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: ImportStatus.COMPLETED } });
    return { created, updated, skipped };
  }

  async cancel(jobId: string, businessId: string) {
    const job = await this.findOne(jobId, businessId);
    if (job.status === ImportStatus.COMPLETED) throw new BadRequestException("A completed import cannot be cancelled.");
    return this.prisma.importJob.update({ where: { id: jobId }, data: { status: ImportStatus.CANCELLED } });
  }
}
