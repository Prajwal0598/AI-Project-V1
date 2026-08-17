import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../../database/prisma.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(input: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (existing) throw new ConflictException("Email already registered.");

    const passwordHash = await bcrypt.hash(input.password, 12);
    const business = await this.prisma.business.create({ data: { name: input.businessName.trim() } });
    const user = await this.prisma.user.create({
      data: { email: input.email.toLowerCase(), name: input.name.trim(), passwordHash, businessId: business.id },
    });

    return this.sign(user.id, business.id);
  }

  async login(input: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
      select: { id: true, businessId: true, passwordHash: true },
    });
    // constant-time rejection: same error message for unknown email and wrong password
    if (!user?.passwordHash) throw new UnauthorizedException("Invalid credentials.");
    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException("Invalid credentials.");
    return this.sign(user.id, user.businessId);
  }

  private sign(userId: string, businessId: string) {
    return { accessToken: this.jwt.sign({ sub: userId, businessId }) };
  }
}
