import { IsIn } from 'class-validator';

import type { PlatformRole } from '../platform-admins.repository';

export class GrantRoleDto {
  @IsIn(['admin', 'super_admin'])
  role!: PlatformRole;
}
