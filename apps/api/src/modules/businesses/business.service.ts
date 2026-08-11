import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { CreateBusinessDto } from "./dto/create-business.dto";

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.business.findMany({ orderBy: { createdAt: "desc" } });
  }

  async create(input: CreateBusinessDto) {
    return this.prisma.business.create({
      data: {
        name: input.name.trim(),
        industry: input.industry?.trim() || null,
        website: input.website?.trim() || null,
        timezone: input.timezone?.trim() || "Asia/Kolkata"
      }
    });
  }
}
