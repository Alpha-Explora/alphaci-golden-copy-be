import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

const BRANCH_NAME =
  /^(?!-)(?!.*\.\.)(?!.*\.$)(?!.*\/$)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[^\s~^:?*[\\]+$/;

/** A branch name only; the service always creates it from dev. */
export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(BRANCH_NAME, { message: 'branchName must be a valid branch name' })
  branchName!: string;
}
