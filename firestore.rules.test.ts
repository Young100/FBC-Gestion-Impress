/**
 * Phase 0: Security Rules Adversarial Test Specification ("Dirty Dozen")
 * Verifies all 12 attack vectors against FBC Print Firestore Security Rules.
 */
export const DIRTY_DOZEN_CASES = [
  { name: 'List Orders Scrape (unauthenticated)', path: '/orders', op: 'list', expected: 'PERMISSION_DENIED' },
  { name: 'List Payments Scrape (unauthenticated)', path: '/payments', op: 'list', expected: 'PERMISSION_DENIED' },
  { name: 'Clients PII Scrape (non-staff)', path: '/clients/c1', op: 'get', expected: 'PERMISSION_DENIED' },
  { name: 'Shadow Field Injection on Order', path: '/orders/ord_1', op: 'create', payload: { isPaidBypass: true }, expected: 'PERMISSION_DENIED' },
  { name: 'Fake Paid Status on Order Create', path: '/orders/ord_2', op: 'create', payload: { paymentStatus: 'paye' }, expected: 'PERMISSION_DENIED' },
  { name: 'Orphan Payment Injection', path: '/payments/pay_1', op: 'create', payload: { orderId: 'nonexistent' }, expected: 'PERMISSION_DENIED' },
  { name: 'Self-Validated Payment', path: '/payments/pay_2', op: 'create', payload: { status: 'valide' }, expected: 'PERMISSION_DENIED' },
  { name: 'Privilege Escalation without Invite', path: '/admin_users/uid_x', op: 'create', payload: { role: 'admin' }, expected: 'PERMISSION_DENIED' },
  { name: 'Spoofed Unverified Email Admin', path: '/services/s1', op: 'update', auth: { email: 'ouattaraabdoulaye479@gmail.com', email_verified: false }, expected: 'PERMISSION_DENIED' },
  { name: 'Tariff Tampering by Operator', path: '/services/s1', op: 'update', role: 'operator', expected: 'PERMISSION_DENIED' },
  { name: 'Audit Log Deletion', path: '/audit_logs/log_1', op: 'delete', role: 'admin', expected: 'PERMISSION_DENIED' },
  { name: 'Resource Poisoning (Oversized ID/Name)', path: '/orders/' + 'a'.repeat(300), op: 'create', expected: 'PERMISSION_DENIED' },
];
