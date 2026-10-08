import { IsUUID } from 'class-validator';

/**
 * The person to add to a Project. Their kind (developer | qa) is derived from
 * their global app_role; the caller cannot choose it.
 */
export class AddDeliveryProjectMemberDto {
  @IsUUID()
  userId: string = '';
}
