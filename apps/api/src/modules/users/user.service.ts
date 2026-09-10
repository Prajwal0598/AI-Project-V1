import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../../database/prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string) {
    return this.prisma.user.findMany({
      where: { businessId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async create(businessId: string, input: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (existing) throw new ConflictException("Email already registered.");
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: { businessId, email: input.email.toLowerCase(), name: input.name.trim(), passwordHash, role: input.role },
    });
    return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt };
  }

  async updateRole(userId: string, businessId: string, role: UserRole) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, businessId } });
    if (!user) throw new NotFoundException("User not found.");
    if (user.role === UserRole.OWNER && role !== UserRole.OWNER) {
      const ownerCount = await this.prisma.user.count({ where: { businessId, role: UserRole.OWNER } });
      if (ownerCount <= 1) throw new BadRequestException("A business must always have at least one owner.");
    }
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { role } });
    return { id: updated.id, email: updated.email, name: updated.name, role: updated.role, createdAt: updated.createdAt };
  }
}
