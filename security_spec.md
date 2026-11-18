# FBC Print Security Specification (Phase 0)

## 1. Data Invariants
1. **No Public Order Enumeration**: Unauthenticated clients MUST NEVER be able to list `orders`, `payments`, `clients`, `admin_users`, or `audit_logs`.
2. **Secret Tracking Token & Dual-Factor Lookup**: Clients access a single order ONLY via its high-entropy `orderId` (`get`) or via exact match of `orderNumber_normalizedPhone` in `order_lookups`.
3. **Immutable Audit Trail**: `audit_logs` cannot be modified or deleted even by admins.
4. **Role Isolation**: Only the bootstrapped Super Admin (`ouattaraabdoulaye479@gmail.com` with `email_verified == true`) or verified `admin_users` with `role == 'admin'` can edit `services`, `payment_methods`, `settings`, `admin_invites`, or view financial `audit_logs`. Operators (`role == 'operator'`) can inspect orders/files and update production statuses, but cannot alter tariffs or shop settings.
5. **Privilege Escalation Prevention**: A signed-in user can only register in `admin_users/{uid}` if a matching `admin_invites/{email}` exists and `incoming().role` matches the invite's role.
6. **Payment Integrity**: Clients can only create `payments` with `status == 'en_attente_validation'` referencing an existing order (`exists(/databases/$(database)/documents/orders/$(incoming().orderId))`). Only admins/operators can mark a payment `valide` or `rejete`.
7. **Server Timestamps & Strict Keys**: Every creation/update validates `request.time`, strict `hasAll`/`hasOnly` keys, string length boundaries, and array size bounds.

## 2. The "Dirty Dozen" Attack Payloads
1. **List Orders Scrape**: Unauthenticated `list` on `/orders` -> `PERMISSION_DENIED`.
2. **List Payments Scrape**: Unauthenticated `list` on `/payments` -> `PERMISSION_DENIED`.
3. **Clients PII Scrape**: Unauthenticated or non-staff `get`/`list` on `/clients` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection on Order**: `create /orders/{id}` with extra field `isPaidBypass: true` -> `PERMISSION_DENIED`.
5. **Fake Paid Status on Order Create**: `create /orders/{id}` with `paymentStatus: 'paye'` or `status: 'payee'` -> `PERMISSION_DENIED`.
6. **Orphan Payment Injection**: `create /payments/{id}` pointing to nonexistent `orderId: 'fake_999'` -> `PERMISSION_DENIED`.
7. **Self-Validated Payment**: Unauthenticated `create /payments/{id}` with `status: 'valide'` -> `PERMISSION_DENIED`.
8. **Privilege Escalation**: Random signed-in user writing `/admin_users/{uid}` with `role: 'admin'` without an invite -> `PERMISSION_DENIED`.
9. **Spoofed Unverified Email Admin**: Payload where `email == 'ouattaraabdoulaye479@gmail.com'` but `email_verified == false` -> `PERMISSION_DENIED`.
10. **Tariff Tampering by Operator**: Operator updating `/services/{id}` price -> `PERMISSION_DENIED`.
11. **Audit Log Deletion**: Admin attempting `delete /audit_logs/{id}` -> `PERMISSION_DENIED`.
12. **Resource Poisoning (1MB ID/String)**: `create /orders/{1.5KB_id}` or `customerName` > 120 chars -> `PERMISSION_DENIED`.
