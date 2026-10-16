import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
export class CreateEnrollmentDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsIn(['windows', 'ubuntu']) platform!: 'windows' | 'ubuntu';
  @IsUUID() requestId!: string;
  @IsOptional() @IsUUID() replacesMachineId?: string;
}
export class HostCheckDto {
  @Matches(/^[a-z0-9-]{1,60}$/) id!: string;
  @IsIn(['passed', 'failed', 'unverified']) status!:
    | 'passed'
    | 'failed'
    | 'unverified';
  @IsString() @MaxLength(300) message!: string;
}
export class MachineCheckInDto {
  @IsString() @MinLength(1) @MaxLength(80) agentVersion!: string;
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => HostCheckDto)
  checks!: HostCheckDto[];
}
/** One tunnel-mode assignment on the machine, as the machine last observed it. */
export class TunnelReportDto {
  @IsUUID() assignmentId!: string;
  @IsIn(['starting', 'running', 'unavailable', 'failed'])
  status!: 'starting' | 'running' | 'unavailable' | 'failed';
  @IsString() @MaxLength(300) message!: string;
  /** The Cloudflare quick tunnel address; only a running tunnel has one. */
  @ValidateIf((_object, value: unknown) => value !== null)
  @Matches(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/)
  @MaxLength(260)
  publicUrl!: string | null;
}
export class HeartbeatDto extends MachineCheckInDto {
  /** Every tunnel-mode assignment on this machine. Omitted by older agents. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TunnelReportDto)
  tunnels?: TunnelReportDto[];
}
export class ConsumeEnrollmentDto extends MachineCheckInDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/) code!: string;
}
export class RevokeMachineDto {
  /** An active machine of the same workspace that takes over the environments. */
  @IsOptional() @IsUUID() replacementMachineId?: string;
}
