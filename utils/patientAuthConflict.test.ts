import { describe, expect, it } from 'vitest';
import { getPatientAuthConflictMessage } from './patientAuthConflict';

describe('patient portal auth conflicts', () => {
  it('turns the database email constraint into an actionable message', () => {
    expect(getPatientAuthConflictMessage({
      code: '23505',
      message: 'duplicate key value violates unique constraint "patient_auth_email_key"'
    })).toContain('email is already used by another patient portal account');
  });

  it('leaves unrelated database errors unchanged', () => {
    expect(getPatientAuthConflictMessage({ code: '42501', message: 'permission denied' })).toBeNull();
  });
});
