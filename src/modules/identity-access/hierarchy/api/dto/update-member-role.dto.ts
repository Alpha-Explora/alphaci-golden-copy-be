import { IsIn } from 'class-validator';

import type { GroupRole } from '../../domain/hierarchy.types';

const GROUP_ROLES: GroupRole[] = [
  'admin',
  'delegated_lead',
  'member',
  'viewer',
];

export class UpdateMemberRoleDto {
  @IsIn(GROUP_ROLES)
  role: GroupRole = 'member';
}
