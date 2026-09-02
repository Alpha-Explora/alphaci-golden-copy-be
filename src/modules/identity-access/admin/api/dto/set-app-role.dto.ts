import { IsIn } from 'class-validator';

import type { AppRole } from '../../infrastructure/platform-admins.repository';

export class SetAppRoleDto {
  @IsIn(['admin', 'lead', 'member'])
  role!: AppRole;
}
