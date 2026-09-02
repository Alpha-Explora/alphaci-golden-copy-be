import { IsIn } from 'class-validator';

import type { PlatformRole } from '../../infrastructure/platform-admins.repository';

export class GrantRoleDto {
  @IsIn(['admin', 'super_admin'])
  role!: PlatformRole;
}
