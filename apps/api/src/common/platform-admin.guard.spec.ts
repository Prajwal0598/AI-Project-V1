import { ForbiddenException } from "@nestjs/common";
import { PlatformAdminGuard } from "./platform-admin.guard";

function contextWithUser(user: unknown) {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any;
}

describe("PlatformAdminGuard", () => {
  const guard = new PlatformAdminGuard();

  it("allows a user with isPlatformAdmin true", () => {
    expect(guard.canActivate(contextWithUser({ isPlatformAdmin: true }))).toBe(true);
  });

  it("rejects a user with isPlatformAdmin false", () => {
    expect(() => guard.canActivate(contextWithUser({ isPlatformAdmin: false }))).toThrow(ForbiddenException);
  });

  it("rejects when there's no user on the request at all", () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
