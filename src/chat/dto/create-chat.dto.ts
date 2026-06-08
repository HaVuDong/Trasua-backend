export class CreateGroupDto {
  name: string;
  memberIds: string[];
}

export class SendMessageDto {
  text?: string;
  fileUrl?: string;
  fileName?: string;
  isImportant?: boolean;
}
