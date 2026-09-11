import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    return this.prisma.category.findMany({ where: { businessId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  }

  async create(businessId: string, input: CreateCategoryDto) {
    return this.prisma.category.create({
      data: { businessId, name: input.name.trim(), parentId: input.parentId ?? null, sortOrder: input.sortOrder ?? 0 },
    });
  }

  async update(categoryId: string, businessId: string, input: UpdateCategoryDto) {
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, businessId } });
    if (!category) throw new NotFoundException("Category not found.");
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
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, businessId } });
    if (!category) throw new NotFoundException("Category not found.");
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
}
