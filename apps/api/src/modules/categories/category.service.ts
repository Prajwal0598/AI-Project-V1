import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    const categories = await this.prisma.category.findMany({
      where: { businessId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { products: true } } },
    });
    return categories.map(({ _count, ...c }) => ({ ...c, productCount: _count.products }));
  }

  async create(businessId: string, input: CreateCategoryDto) {
    const name = input.name.trim();
    // guards against the exact bug that let products silently vanish from the WhatsApp category browse
    // list: a duplicate top-level category name resolves ambiguously (product-category assignment goes
    // through name lookup for CSV import/AI-suggested categories, which would pick whichever duplicate
    // happened to match first — not necessarily the one a product was actually assigned to)
    const existing = await this.prisma.category.findFirst({ where: { businessId, parentId: input.parentId ?? null, name: { equals: name, mode: "insensitive" } } });
    if (existing) throw new BadRequestException(`A category named "${name}" already exists.`);
    return this.prisma.category.create({
      data: { businessId, name, parentId: input.parentId ?? null, sortOrder: input.sortOrder ?? 0 },
    });
  }

  async update(categoryId: string, businessId: string, input: UpdateCategoryDto) {
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, businessId } });
    if (!category) throw new NotFoundException("Category not found.");
    if (input.name !== undefined) {
      const name = input.name.trim();
      const parentId = input.parentId !== undefined ? (input.parentId || null) : category.parentId;
      const clash = await this.prisma.category.findFirst({ where: { businessId, parentId, id: { not: categoryId }, name: { equals: name, mode: "insensitive" } } });
      if (clash) throw new BadRequestException(`A category named "${name}" already exists.`);
    }
    return this.prisma.category.update({
      where: { id: categoryId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.parentId !== undefined && { parentId: input.parentId || null }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.active !== undefined && { active: input.active }),
      },
    });
  }

  async remove(categoryId: string, businessId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, businessId },
      include: { _count: { select: { products: true, children: true } } },
    });
    if (!category) throw new NotFoundException("Category not found.");
    if (category._count.products > 0) throw new BadRequestException(`Move or reassign the ${category._count.products} product(s) in this category before deleting it.`);
    if (category._count.children > 0) throw new BadRequestException("Delete or reassign this category's subcategories before deleting it.");
    await this.prisma.category.delete({ where: { id: categoryId } });
  }

  /** Finds a top-level category by name (case-insensitive), creating it if it doesn't exist yet — used by product create/update and catalogue import, which only deal in plain category names. */
  async resolveIdByName(businessId: string, name: string | null | undefined): Promise<string | null> {
    const trimmed = name?.trim();
    if (!trimmed) return null;
    const existing = await this.prisma.category.findFirst({ where: { businessId, parentId: null, name: { equals: trimmed, mode: "insensitive" } } });
    if (existing) return existing.id;
    const created = await this.prisma.category.create({ data: { businessId, name: trimmed } });
    return created.id;
  }

  /**
   * One-time repair for businesses that ended up with duplicate categories (same name, same parent) before
   * create()/update() started rejecting them — this is what caused products assigned via the name-based
   * lookup to land on a different, near-empty duplicate than the one shown in the WhatsApp category browse
   * list. Groups by case-insensitive name + parentId, keeps whichever duplicate has the most products
   * (ties broken by oldest), reassigns every product/child-category from the rest onto the keeper, then
   * deletes the now-empty duplicates.
   */
  async mergeDuplicates(businessId: string) {
    const categories = await this.prisma.category.findMany({
      where: { businessId },
      include: { _count: { select: { products: true } } },
      orderBy: { createdAt: "asc" },
    });

    const groups = new Map<string, typeof categories>();
    for (const c of categories) {
      const key = `${c.parentId ?? ""}::${c.name.trim().toLowerCase()}`;
      const group = groups.get(key);
      if (group) group.push(c); else groups.set(key, [c]);
    }

    let merged = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [keeper, ...duplicates] = [...group].sort((a, b) => b._count.products - a._count.products || a.createdAt.getTime() - b.createdAt.getTime());
      const duplicateIds = duplicates.map((d) => d.id);
      await this.prisma.$transaction([
        this.prisma.product.updateMany({ where: { categoryId: { in: duplicateIds } }, data: { categoryId: keeper.id } }),
        this.prisma.category.updateMany({ where: { parentId: { in: duplicateIds } }, data: { parentId: keeper.id } }),
        this.prisma.category.deleteMany({ where: { id: { in: duplicateIds } } }),
      ]);
      merged += duplicateIds.length;
    }
    return { duplicatesMerged: merged };
  }
}
