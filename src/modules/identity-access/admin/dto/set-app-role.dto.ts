import { IsIn } from 'class-validator';

import type { AppRole } from '../platform-admins.repository';

export class SetAppRoleDto {
  @IsIn(['admin', 'lead', 'member'])
  role!: AppRole;
}
