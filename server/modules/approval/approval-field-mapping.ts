import type { ApprovalControl } from '@shared/approval';

export interface ApprovalFieldMapping {
  apiType: number;
  baseFieldType: string;
}

const APPROVAL_FIELD_MAPPINGS: Readonly<
  Record<string, ApprovalFieldMapping>
> = {
  text: { apiType: 1, baseFieldType: 'text' },
  input: { apiType: 1, baseFieldType: 'text' },
  textarea: { apiType: 1, baseFieldType: 'text' },
  phone: { apiType: 1, baseFieldType: 'text' },
  url: { apiType: 1, baseFieldType: 'text' },
  radiov2: { apiType: 3, baseFieldType: 'select' },
  radio: { apiType: 3, baseFieldType: 'select' },
  number: { apiType: 2, baseFieldType: 'number' },
  amount: { apiType: 2, baseFieldType: 'amount' },
  formula: { apiType: 2, baseFieldType: 'number' },
  date: { apiType: 5, baseFieldType: 'date' },
  datetime: { apiType: 5, baseFieldType: 'date' },
  checkbox: { apiType: 7, baseFieldType: 'checkbox' },
  checkboxv2: { apiType: 7, baseFieldType: 'checkbox' },
  contact: { apiType: 11, baseFieldType: 'user' },
  user: { apiType: 11, baseFieldType: 'user' },
  department: { apiType: 1, baseFieldType: 'text' },
  attachment: { apiType: 17, baseFieldType: 'attachment' },
  attachmentv2: { apiType: 17, baseFieldType: 'attachment' },
  image: { apiType: 17, baseFieldType: 'attachment' },
  imagev2: { apiType: 17, baseFieldType: 'attachment' },
};

export function approvalFieldMapping(
  control: ApprovalControl,
): ApprovalFieldMapping | undefined {
  const key = control.type.trim().toLowerCase().replace(/[-_]/gu, '');
  return APPROVAL_FIELD_MAPPINGS[key];
}
