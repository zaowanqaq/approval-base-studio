import { Injectable } from '@nestjs/common';
import type {
  ApprovalControl,
  TargetFieldMatchSuggestion,
} from '../../../shared/approval';
import { approvalFieldMapping } from './approval-field-mapping';
import type { BitableFieldMeta } from './bitable-record.service';

@Injectable()
export class TargetFieldMatchingService {
  suggest(
    controls: ApprovalControl[],
    fields: BitableFieldMeta[],
  ): TargetFieldMatchSuggestion[] {
    return controls.map((control: ApprovalControl) => {
      const normalizedName = this.normalize(control.name);
      const compatible = fields.filter((field: BitableFieldMeta) =>
        this.compatible(control, field.type));
      const exact = compatible.filter(
        (field: BitableFieldMeta) => this.normalize(field.fieldName) === normalizedName,
      );
      const candidate = exact[0] || compatible[0];
      if (!candidate) {
        return {
          targetControlId: control.id,
          targetControlName: control.name,
          targetControlType: control.type,
          score: 0,
          reason: 'no-match',
        };
      }
      const exactName = this.normalize(candidate.fieldName) === normalizedName;
      return {
        targetControlId: control.id,
        targetControlName: control.name,
        targetControlType: control.type,
        baseFieldId: candidate.fieldId,
        baseFieldName: candidate.fieldName,
        baseFieldType: candidate.type,
        score: exactName ? 100 : 30,
        reason: exactName ? 'name-and-type' : 'type-only',
      };
    });
  }

  private compatible(control: ApprovalControl, fieldType: number): boolean {
    const mapping = approvalFieldMapping(control);
    if (!mapping) return false;
    if (mapping.apiType === 1) return [1, 13, 15].includes(fieldType);
    return mapping.apiType === fieldType;
  }

  private normalize(value: string): string {
    return value.trim().replace(/\s+/gu, '').toLocaleLowerCase();
  }
}
