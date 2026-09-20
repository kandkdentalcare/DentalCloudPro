export const getPatientAuthConflictMessage = (error: unknown): string | null => {
  const candidate = error as { code?: string; message?: string; details?: string } | null;
  const text = `${candidate?.message || ''} ${candidate?.details || ''}`.toLowerCase();
  if (candidate?.code !== '23505' && !text.includes('duplicate key value')) return null;

  if (text.includes('patient_auth_email_key') || text.includes('(email)')) {
    return 'This email is already used by another patient portal account. Update the patient email or use the existing portal account.';
  }
  if (text.includes('patient_auth_username_key') || text.includes('(username)')) {
    return 'This username is already used by another patient portal account. Choose a different username.';
  }
  return 'Another patient portal account already uses these login details.';
};
