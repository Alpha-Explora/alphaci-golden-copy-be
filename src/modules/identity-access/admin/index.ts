export { AdminModule } from './admin.module';
export {
  PlatformAdminAccessService,
  type AppRole,
  type AppRoleSource,
  type PlatformRole,
} from './application/platform-admin-access.service';
export { PlatformAdminGuard } from './api/guards/platform-admin.guard';
export { SuperAdminGuard } from './api/guards/super-admin.guard';
export type {
  PlatformAdminContract,
  PlatformAppRoleContract,
  PlatformRoleContract,
} from './contracts/platform-admin.contract';
