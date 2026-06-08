import { LeaveRequestStatus } from '../schemas/leave-request.schema';

export class ReviewLeaveDto {
  status: LeaveRequestStatus;
  reviewNotes?: string;
  isPaid?: boolean;
}
