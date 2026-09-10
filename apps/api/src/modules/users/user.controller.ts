import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { UserRole } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { Roles } from "../../common/roles.decorator";
import { RolesGuard } from "../../common/roles.guard";
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";

@Controller()
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get("businesses/:businessId/users")
  list(@Param("businessId") businessId: string, @GetUser() user: User) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.users.list(businessId);
  }

  // only an OWNER can add teammates — prevents an ADMIN from creating another ADMIN/OWNER to escalate privileges
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER)
  @Post("businesses/:businessId/users")
  create(@Param("businessId") businessId: string, @GetUser() user: User, @Body() input: CreateUserDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.users.create(businessId, input);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER)
  @Patch("users/:userId/role")
  updateRole(@Param("userId") userId: string, @GetUser() user: User, @Body() input: UpdateUserRoleDto) {
    return this.users.updateRole(userId, user.businessId, input.role);
  }
}
