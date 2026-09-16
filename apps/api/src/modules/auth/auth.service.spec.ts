import { UnauthorizedException } from "@nestjs/common";
import type { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";
import type { PrismaService } from "../../database/prisma.service";

describe("AuthService", () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
    business: { create: jest.Mock };
    refreshToken: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock; create: jest.Mock };
  };
  let jwt: { sign: jest.Mock };
  let auth: AuthService;
  let realPasswordHash: string;

  beforeAll(async () => {
    realPasswordHash = await bcrypt.hash("correct-password", 12);
  });

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      business: { create: jest.fn() },
      refreshToken: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    };
    jwt = { sign: jest.fn().mockReturnValue("signed.jwt.token") };
    auth = new AuthService(prisma as unknown as PrismaService, jwt as unknown as JwtService);
  });

  describe("login", () => {
    it("rejects an unknown email with a generic message", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(auth.login({ email: "nobody@test.com", password: "x" })).rejects.toThrow(UnauthorizedException);
      await expect(auth.login({ email: "nobody@test.com", password: "x" })).rejects.toThrow("Invalid credentials.");
    });

    it("rejects while the account is locked, without even checking the password", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1", businessId: "b1", passwordHash: realPasswordHash,
        failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + 60_000),
      });
      await expect(auth.login({ email: "a@test.com", password: "correct-password" }))
        .rejects.toThrow("This account is temporarily locked due to repeated failed login attempts. Try again later.");
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("increments the failed-attempt counter on wrong password, without locking below the threshold", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1", businessId: "b1", passwordHash: realPasswordHash, failedLoginAttempts: 3, lockedUntil: null,
      });
      await expect(auth.login({ email: "a@test.com", password: "wrong" })).rejects.toThrow("Invalid credentials.");
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { failedLoginAttempts: 4, lockedUntil: null },
      });
    });

    it("locks the account and resets the counter once the 5th failed attempt is reached", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1", businessId: "b1", passwordHash: realPasswordHash, failedLoginAttempts: 4, lockedUntil: null,
      });
      await expect(auth.login({ email: "a@test.com", password: "wrong" }))
        .rejects.toThrow("Too many failed attempts — this account is now temporarily locked. Try again later.");
      const call = prisma.user.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: "u1" });
      expect(call.data.failedLoginAttempts).toBe(0);
      expect(call.data.lockedUntil).toBeInstanceOf(Date);
      expect(call.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it("clears the failed-attempt counter and issues tokens on a correct password", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1", businessId: "b1", passwordHash: realPasswordHash, failedLoginAttempts: 2, lockedUntil: null,
      });
      prisma.refreshToken.create.mockResolvedValue({});
      const result = await auth.login({ email: "a@test.com", password: "correct-password" });
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { failedLoginAttempts: 0, lockedUntil: null } });
      expect(result.accessToken).toBe("signed.jwt.token");
      expect(typeof result.refreshToken).toBe("string");
      expect(jwt.sign).toHaveBeenCalledWith({ sub: "u1", businessId: "b1" });
    });
  });

  describe("refresh", () => {
    it("rejects an unknown, expired, or revoked token", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(auth.refresh("bad-token")).rejects.toThrow(UnauthorizedException);

      prisma.refreshToken.findUnique.mockResolvedValue({ id: "rt1", userId: "u1", revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
      await expect(auth.refresh("revoked-token")).rejects.toThrow(UnauthorizedException);

      prisma.refreshToken.findUnique.mockResolvedValue({ id: "rt1", userId: "u1", revokedAt: null, expiresAt: new Date(Date.now() - 60_000) });
      await expect(auth.refresh("expired-token")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects if the token's user no longer exists", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({ id: "rt1", userId: "gone", revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(auth.refresh("token")).rejects.toThrow(UnauthorizedException);
    });

    it("rotates a valid token: revokes the old one and issues a new pair", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({ id: "rt1", userId: "u1", revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
      prisma.user.findUnique.mockResolvedValue({ id: "u1", businessId: "b1" });
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await auth.refresh("valid-token");

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({ where: { id: "rt1" }, data: { revokedAt: expect.any(Date) } });
      expect(result.accessToken).toBe("signed.jwt.token");
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("revokes the matching, not-yet-revoked refresh token", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      const result = await auth.logout("some-token");
      expect(result).toEqual({ ok: true });
      const call = prisma.refreshToken.updateMany.mock.calls[0][0];
      expect(call.where.revokedAt).toBeNull();
      expect(call.data.revokedAt).toBeInstanceOf(Date);
    });

    it("is a harmless no-op (still returns ok) if the token doesn't match anything", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(auth.logout("unknown-token")).resolves.toEqual({ ok: true });
    });
  });
});
