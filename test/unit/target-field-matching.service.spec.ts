import { TargetFieldMatchingService } from '../../server/modules/approval/target-field-matching.service';
import type { ApprovalControl } from '../../shared/approval';
import type { BitableFieldMeta } from '../../server/modules/approval/bitable-record.service';

describe('TargetFieldMatchingService', () => {
  it('recommends a stable Base field ID only when name and type match', () => {
    const controls: ApprovalControl[] = [
      {
        id: 'control-title',
        name: '标题',
        type: 'input',
        required: true,
        visible: true,
      },
      {
        id: 'control-amount',
        name: '金额',
        type: 'amount',
        required: true,
        visible: true,
      },
    ];
    const fields: BitableFieldMeta[] = [
      { fieldId: 'field-title', fieldName: '标题', type: 1 },
      { fieldId: 'field-amount-text', fieldName: '金额', type: 1 },
      { fieldId: 'field-amount', fieldName: '其他金额', type: 2 },
    ];
    const suggestions = new TargetFieldMatchingService().suggest(controls, fields);
    expect(suggestions[0]).toMatchObject({
      baseFieldId: 'field-title',
      score: 100,
      reason: 'name-and-type',
    });
    expect(suggestions[1]).toMatchObject({
      baseFieldId: 'field-amount',
      score: 30,
      reason: 'type-only',
    });
  });
});
