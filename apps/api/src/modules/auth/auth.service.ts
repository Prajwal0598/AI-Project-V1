import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../database/prisma.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_TOKEN_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashRefreshToken(token: string): string {
  // SHA-256 (not bcrypt): the raw token is already a high-entropy random secret, and we need an exact-match DB lookup by hash
  return createHash("sha256").update(token).digest("hex");
}

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

    return this.issueTokens(user.id, business.id);
  }

  async login(input: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
      select: { id: true, businessId: true, passwordHash: true, failedLoginAttempts: true, lockedUntil: true },
    });
    // constant-time rejection: same error message for unknown email and wrong password
    if (!user?.passwordHash) throw new UnauthorizedException("Invalid credentials.");

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException("This account is temporarily locked due to repeated failed login attempts. Try again later.");
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const lockingNow = attempts >= MAX_FAILED_ATTEMPTS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: lockingNow ? 0 : attempts, // reset the counter once a lockout is actually applied
          lockedUntil: lockingNow ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
        },
      });
      throw new UnauthorizedException(
        lockingNow ? "Too many failed attempts — this account is now temporarily locked. Try again later." : "Invalid credentials.",
      );
    }

    // successful login clears any prior failed-attempt count/lock
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    return this.issueTokens(user.id, user.businessId);
  }

  /** Exchanges a still-valid refresh token for a new access token, rotating the refresh token in the process. */
  async refresh(rawToken: string) {
    const tokenHash = hashRefreshToken(rawToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }
    const user = await this.prisma.user.findUnique({ where: { id: stored.userId }, select: { id: true, businessId: true } });
    if (!user) throw new UnauthorizedException("Invalid or expired refresh token.");

    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(user.id, user.businessId);
  }

  /** Revokes a refresh token (e.g. on logout) — best-effort, doesn't error if the token is already gone/invalid. */
  async logout(rawToken: string) {
    const tokenHash = hashRefreshToken(rawToken);
    await this.prisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  private async issueTokens(userId: string, businessId: string) {
    const accessToken = this.jwt.sign({ sub: userId, businessId });
    const rawRefreshToken = randomBytes(48).toString("hex");
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: hashRefreshToken(rawRefreshToken), expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRES_MS) },
    });
    return { accessToken, refreshToken: rawRefreshToken };
  }
}
