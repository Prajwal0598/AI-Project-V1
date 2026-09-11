import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { UserRole } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { Roles } from "../../common/roles.decorator";
import { RolesGuard } from "../../common/roles.guard";
import { ImportService } from "./import.service";
import { UpdateImportRowDto } from "./dto/update-import-row.dto";

const ALLOWED_MIMETYPES = new Set([
  "text/csv", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream", // some browsers send this for .csv/.xlsx
]);

const uploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req: unknown, file: Express.Multer.File, cb: (error: Error | null, accept: boolean) => void) => {
    const ext = file.originalname.split(".").pop()?.toLowerCase();
    if ((ext === "csv" || ext === "xlsx" || ext === "xls") && ALLOWED_MIMETYPES.has(file.mimetype)) cb(null, true);
    else cb(new BadRequestException("Only .csv and .xlsx files are supported."), false);
  },
};

@Controller()
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Get("businesses/:businessId/imports")
  findAll(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.imports.findAll(businessId);
  }

  @Post("businesses/:businessId/imports")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor("file", uploadOptions))
  create(@Param("businessId") businessId: string, @GetUser() user: { id: string; businessId: string }, @UploadedFile() file: Express.Multer.File) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.imports.create(businessId, file, user.id);
  }

  @Get("imports/:id")
  findOne(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.imports.findOne(id, user.businessId);
  }

  @Get("imports/:id/rows")
  findRows(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.imports.findRows(id, user.businessId);
  }

  @Patch("imports/:id/rows/:rowId")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  updateRow(@Param("id") id: string, @Param("rowId") rowId: string, @GetUser() user: { businessId: string }, @Body() input: UpdateImportRowDto) {
    return this.imports.updateRow(id, rowId, user.businessId, input);
  }

  @Post("imports/:id/commit")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  commit(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.imports.commit(id, user.businessId);
  }

  @Post("imports/:id/cancel")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  cancel(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.imports.cancel(id, user.businessId);
  }
}
