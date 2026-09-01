# Ecommerce Platform — Claude Project Instructions

## 1. Project Identity

This project is a production-oriented, full-stack, single-store Ecommerce platform inspired by the core capabilities of platforms such as Shopify.

The system is designed to operate and manage **one online store**.

The goal is not to create a simple CRUD application. The backend should provide a robust foundation for:

* Customer management
* Product management
* Category management
* Inventory management
* Order management
* Shipping management
* Payment management
* Discount and coupon management
* Authentication and authorization
* Notifications
* Email communication
* Real-time communication
* Analytics
* Dashboard data
* Store settings
* Background processing
* Auditing and operational visibility

The architecture should be:

* Feature-based
* Modular
* Maintainable
* Secure
* Reliable
* Testable
* Observable
* Event-aware
* Worker-oriented
* Designed for future growth

Do not introduce unnecessary enterprise complexity.

The system should be scalable within the context of a **single store**.

---

# 2. Applications

The project contains three primary applications:

```text
Ecommerce/
├── client/
├── admin/
├── server/
└── ...
```

## `client/`

Customer-facing storefront.

Responsibilities include:

* Product browsing
* Product search
* Product filtering
* Product details
* Cart
* Checkout
* Customer authentication
* Customer profile
* Address management
* Order placement
* Order history
* Order tracking
* Customer notifications

The client must never directly access the database.

---

## `admin/`

Administrative dashboard for store owners and authorized staff.

Responsibilities include:

* Dashboard
* Customer management
* Product management
* Category management
* Inventory management
* Order management
* Shipping management
* Payment management
* Discount/coupon management
* Analytics
* Notifications
* Store settings
* Operational monitoring

Admin functionality must be protected by backend authorization.

Hiding an admin page or button in React is NOT a security mechanism.

---

## `server/`

Central backend responsible for:

* REST APIs
* Authentication
* Authorization
* Business logic
* Database access
* Validation
* Background workers
* Queues
* Email system
* Notifications
* Socket.IO realtime communication
* Events
* Analytics processing
* Logging
* Error handling
* External integrations

The server is the authoritative source for business rules.

---

# 3. Technology Direction

The expected technology direction is:

## Backend

* Node.js
* Express.js
* JavaScript or TypeScript according to the existing project
* REST API
* Socket.IO

## Database

* PostgreSQL
* Supabase-hosted PostgreSQL

## Authentication

* JWT
* Access tokens
* Refresh tokens

## Frontend

### Client

* React
* Tailwind CSS

### Admin

* React
* Tailwind CSS

Use the existing project's actual dependencies and conventions before introducing new ones.

Do not add libraries simply because they are popular.

Every infrastructure dependency should solve a real project requirement.

---

# 4. Architectural Philosophy

The backend must NOT become a collection of unrelated CRUD endpoints.

Think in terms of:

```text
Business Domain
      ↓
Feature
      ↓
Business Logic
      ↓
Database / External Services
      ↓
Events
      ↓
Workers
      ↓
Notifications / Analytics / Realtime
```

Not every operation requires every layer.

Use each architectural mechanism when it provides a meaningful benefit.

---

# 5. Feature-Based Architecture

Feature-based architecture is a fundamental requirement.

Organize the server primarily around business domains/features.

Prefer:

```text
server/
└── features/
    ├── auth/
    ├── customers/
    ├── products/
    ├── categories/
    ├── inventory/
    ├── orders/
    ├── shipping/
    ├── payments/
    ├── discounts/
    ├── notifications/
    ├── analytics/
    └── ...
```

Avoid a huge global structure where every controller, service, model, and validator from every feature is mixed together.

For example, prefer:

```text
features/
└── orders/
    ├── controllers/
    ├── services/
    ├── routes/
    ├── validators/
    ├── repositories/
    ├── events/
    └── ...
```

over:

```text
controllers/
├── order.controller.js
├── product.controller.js
├── customer.controller.js
└── ...
```

The exact internal organization can evolve, but feature boundaries must remain clear.

---

# 6. Feature Ownership

Each feature should own its domain logic.

Examples:

```text
products
→ product business rules

inventory
→ stock and inventory rules

orders
→ order lifecycle and order rules

shipping
→ fulfillment and shipping rules

payments
→ payment-related business logic

notifications
→ notification creation and delivery

analytics
→ analytics calculations and aggregation
```

Avoid allowing unrelated features to directly manipulate another feature's internal data or implementation.

Prefer:

```text
Feature A
   ↓
Public service/interface/event
   ↓
Feature B
```

instead of:

```text
Feature A
   ↓
Feature B internal database implementation
```

---

# 7. Backend Layering

Within each feature, maintain a sensible separation of responsibilities.

Typical flow:

```text
HTTP Request
     ↓
Route
     ↓
Middleware
     ↓
Controller
     ↓
Service
     ↓
Repository / Database
```

## Routes

Routes should define endpoints and middleware.

Routes should remain lightweight.

Do not place business logic inside routes.

---

## Controllers

Controllers should:

* Receive requests
* Extract input
* Call appropriate services
* Return responses

Controllers should remain thin.

Do not implement complex business logic inside controllers.

---

## Services

Services contain business logic.

Examples:

```text
order.service
inventory.service
product.service
customer.service
shipping.service
payment.service
```

Services should coordinate domain operations and enforce business rules.

---

## Repositories / Data Access

Use a repository/data-access layer when it improves separation and maintainability.

Do not introduce repositories purely as ceremony.

Database access should remain controlled and predictable.

---

# 8. Database Architecture

PostgreSQL is the primary transactional data store.

The database is the source of truth for transactional information.

Use appropriate:

* Primary keys
* Foreign keys
* Unique constraints
* NOT NULL constraints
* CHECK constraints
* Indexes
* Transactions
* Cascading behavior where appropriate

Database design should reflect real business relationships.

Before creating or modifying tables, consider:

* Relationships
* Constraints
* Query patterns
* Indexing
* Data lifecycle
* Historical data
* Deletion behavior
* Transaction boundaries

Do not use application code as the only protection for data integrity when a database constraint is appropriate.

---

# 9. Database Migrations

Database changes must be reproducible.

Do not manually make undocumented database changes that cannot be reproduced in another environment.

Use the project's chosen migration strategy consistently.

Every schema change should consider:

* Existing data
* Backward compatibility
* Indexes
* Constraints
* Foreign keys
* Migration order

Never perform destructive production changes casually.

---

# 10. Authentication

Authentication uses:

* Access tokens
* Refresh tokens
* JWT

Authentication answers:

```text
Who is this user?
```

Authorization answers:

```text
What is this user allowed to do?
```

These must remain separate concepts.

Authentication must be centralized.

Do not duplicate authentication logic across features.

---

# 11. Authorization

Authorization must be enforced on the backend.

Potential roles may include:

```text
customer
admin
staff
```

The exact role model should follow project requirements.

Authorization should support permissions appropriate to administrative operations.

For example:

```text
Admin
→ manage products
→ manage orders
→ manage customers

Staff
→ manage orders
→ manage shipping
```

Do not assume that a frontend role check provides security.

The backend must verify permissions.

---

# 12. Customer Management

Customer management should support:

* Registration
* Authentication
* Profile
* Email verification
* Password management
* Addresses
* Account status
* Order history
* Customer activity

Admin functionality should support:

* Customer listing
* Search
* Filtering
* Customer details
* Order history
* Account status management

Do not unnecessarily duplicate customer data.

---

# 13. Product Management

Products should support appropriate Ecommerce information such as:

* Name
* Description
* SKU
* Price
* Images
* Category
* Inventory
* Status
* Metadata
* Timestamps

The system should support:

* Product creation
* Product editing
* Product archival
* Product retrieval
* Search
* Filtering
* Category assignment
* Inventory association

Use archive/deactivation instead of hard deletion when historical data depends on a product.

---

# 14. Categories

Categories organize products.

Support:

* Creation
* Editing
* Archiving/deletion where safe
* Product assignment
* Search
* Filtering

If hierarchical categories are introduced, model them explicitly.

Do not introduce unnecessary category complexity without a requirement.

---

# 15. Inventory Management

Inventory is a critical domain.

The server must be authoritative regarding stock.

Important rules:

* Never trust stock values from the client.
* Validate inventory server-side.
* Prevent unintended negative stock.
* Protect inventory operations against race conditions.
* Use transactions where necessary.
* Record meaningful inventory movements when appropriate.
* Consider stock restoration when orders are cancelled or reversed.

Possible inventory concepts:

```text
Available Stock
Reserved Stock
Committed Stock
Low Stock Threshold
Inventory Movement
```

Only implement the concepts actually required by the business model.

Inventory changes must be traceable when practical.

---

# 16. Order Management

Orders are a core domain.

An order may contain:

```text
Order
├── Customer
├── Items
├── Pricing
├── Discounts
├── Taxes
├── Shipping
├── Payment
├── Status
└── Timestamps
```

Order items should preserve historical information.

When an order is created, do not depend exclusively on the current product record for historical values.

Store appropriate snapshots such as:

```text
Product ID
Product Name
SKU
Unit Price
Quantity
```

This ensures historical orders remain accurate after products change.

---

# 17. Order Lifecycle

Order status must be explicit.

Potential states:

```text
pending
confirmed
processing
ready_to_ship
shipped
delivered
cancelled
returned
```

Use only the statuses required by the project.

Status transitions must be validated.

Do not allow arbitrary status strings.

For important transitions, consider recording:

```text
Previous Status
New Status
Changed By
Reason
Timestamp
```

---

# 18. Order Consistency

Order creation is a critical transactional workflow.

Conceptually:

```text
Create Order
    ↓
Validate Customer
    ↓
Validate Products
    ↓
Validate Prices
    ↓
Validate Inventory
    ↓
Calculate Totals
    ↓
Create Order
    ↓
Update/Reserve Inventory
    ↓
Commit Transaction
    ↓
Publish Events
```

Critical transactional operations should not depend on unreliable external systems.

Do not send an email or perform a non-critical external API call in the middle of a critical database transaction.

---

# 19. Shipping Management

Shipping is a dedicated business domain.

It may include:

* Shipping methods
* Shipping rates
* Shipping address
* Carrier
* Tracking number
* Fulfillment
* Shipment status
* Delivery information

Potential shipment states:

```text
pending
processing
shipped
in_transit
delivered
returned
failed
```

Shipping workflows should be designed independently from the UI.

Customers should receive relevant shipping information through the client.

Admins should manage fulfillment through the admin application.

---

# 20. Payment Management

Payment functionality must be isolated behind a clear payment domain/service.

Do not tightly couple the entire order system to a specific payment provider.

The system should be designed so a provider can be replaced or extended.

Potential payment states:

```text
pending
authorized
paid
failed
refunded
partially_refunded
cancelled
```

Payment operations must be idempotent where required.

Never store raw card information.

Never expose payment provider secrets to frontend applications.

Payment webhooks must be authenticated/verified and processed safely.

---

# 21. Discounts and Coupons

Discount functionality may support:

* Coupon codes
* Percentage discounts
* Fixed discounts
* Minimum order requirements
* Expiration
* Usage limits
* Customer eligibility
* Product/category restrictions

Discount calculations must happen on the server.

Never trust discount totals supplied by the client.

---

# 22. Background Workers

Background processing is a **first-class architectural requirement**.

Do not perform slow, expensive, or non-critical work directly inside HTTP request handlers when it can be processed asynchronously.

Suitable background work includes:

* Emails
* Notifications
* Analytics processing
* Report generation
* Image processing
* External synchronization
* Cleanup jobs
* Scheduled tasks
* Data aggregation
* Webhook processing where appropriate
* Non-critical external API operations

Typical flow:

```text
API Request
    ↓
Critical Transaction
    ↓
Create Event / Job
    ↓
Return Response
    ↓
Worker
    ↓
Background Operation
```

The API should remain responsive.

---

# 23. Queue System

Use a reliable job queue when background processing requires:

* Retry
* Delayed jobs
* Scheduled jobs
* Failure handling
* Concurrency control
* Job tracking
* Idempotency

The exact queue technology should be selected based on actual project requirements.

Do not introduce a queue without a clear use case.

---

# 24. Worker Reliability

Workers must account for failures.

Where appropriate, support:

* Retries
* Exponential backoff
* Failed jobs
* Logging
* Idempotency
* Dead-letter/failed-job handling
* Job status

Example:

```text
Job
 ↓
Worker
 ↓
Failure
 ↓
Retry
 ↓
Failure
 ↓
Retry
 ↓
Failed Job
```

A retry must not accidentally:

* Create duplicate orders
* Charge customers twice
* Modify inventory twice
* Send uncontrolled duplicate notifications

Design critical workers to be idempotent.

---

# 25. Email System

Email must be a dedicated subsystem.

Do not send emails directly from random controllers.

Preferred architecture:

```text
Feature
   ↓
Notification / Email Service
   ↓
Job Queue
   ↓
Email Worker
   ↓
Email Provider
```

Potential emails:

* Welcome
* Email verification
* Password reset
* Order confirmation
* Payment confirmation
* Order status update
* Shipping notification
* Delivery notification
* Cancellation
* Refund
* Promotional communication

---

# 26. Email Templates

Email templates should be:

* Reusable
* Version-controlled
* Clearly organized
* Data-driven

Do not hardcode large HTML email bodies inside controllers.

Email sending should support appropriate:

* Logging
* Retry
* Failure handling
* Template variables
* Provider errors

Email credentials must remain server-side.

---

# 27. Notifications

The system should have a notification concept separate from email.

A notification may be delivered through:

```text
In-App
Email
Realtime
```

For example:

```text
Order shipped
    ↓
Notification
    ├── In-app notification
    ├── Email
    └── Socket event
```

Not every notification requires every channel.

Users should not receive duplicate notifications unnecessarily.

---

# 28. Real-Time Communication

Socket.IO is a core part of the architecture for genuine realtime requirements.

Use realtime communication for things such as:

### Admin

* New order notifications
* Order status changes
* Inventory alerts
* Low-stock alerts
* Payment updates
* Shipping updates
* Dashboard metric updates
* Operational notifications

### Client

* Order status changes
* Shipping updates
* Relevant notifications

Do not use Socket.IO for normal CRUD operations that do not require realtime updates.

REST remains the default request/response mechanism.

---

# 29. Socket Architecture

Socket handling must be centralized.

Conceptual structure:

```text
server/
└── realtime/
    ├── socket.js
    ├── authentication/
    ├── handlers/
    └── events/
```

Use consistent event naming.

Examples:

```text
order.created
order.updated
order.shipped
order.delivered

inventory.low
inventory.updated

notification.created

payment.completed
payment.failed
```

Authenticated socket connections must be authorized.

Never trust client-provided identity.

---

# 30. Events

Use domain/business events where they provide useful decoupling.

Examples:

```text
CustomerRegistered
ProductCreated
ProductUpdated

OrderCreated
OrderConfirmed
OrderCancelled
OrderShipped
OrderDelivered

PaymentCompleted
PaymentFailed
RefundCreated

InventoryLow
InventoryUpdated

ShipmentCreated
ShipmentDelivered
```

An event may trigger:

```text
OrderCreated
    ├── Email
    ├── Analytics
    ├── Notification
    └── Realtime update
```

Events should not replace normal synchronous business logic.

Use events where independent consumers benefit from decoupling.

---

# 31. Event Rules

Events should be:

* Explicit
* Predictable
* Meaningful
* Well named
* Documented where necessary

Avoid creating events for trivial internal function calls.

Do not use event-driven architecture merely to make code appear sophisticated.

Use it where it improves:

* Decoupling
* Reliability
* Extensibility
* Background processing
* Realtime communication
* Analytics

---

# 32. Analytics

Analytics is a major feature of the platform.

The system should provide useful business insights rather than only raw database counts.

Potential analytics include:

## Sales

* Gross sales
* Net sales
* Revenue
* Average order value
* Revenue over time
* Revenue by product
* Revenue by category

## Orders

* Total orders
* Completed orders
* Cancelled orders
* Pending orders
* Orders over time
* Average order value

## Customers

* Total customers
* New customers
* Returning customers
* Customer purchase frequency
* Customer lifetime value when meaningful

## Products

* Best-selling products
* Lowest-performing products
* Product revenue
* Category performance
* Inventory performance

## Inventory

* Current stock
* Low-stock products
* Out-of-stock products
* Inventory movements

## Shipping

* Pending shipments
* Shipped orders
* Orders in transit
* Delivered orders
* Returns

---

# 33. Analytics Architecture

Analytics must not unnecessarily slow down transactional operations.

For expensive analytics:

```text
Transactional Data
       ↓
Analytics Processing
       ↓
Aggregation
       ↓
Cached / Materialized Data
       ↓
Admin Dashboard
```

Use appropriate:

* SQL aggregation
* Indexes
* Caching
* Background processing
* Precomputed metrics
* Materialized views where justified

Do not execute extremely expensive queries every time the dashboard loads if the data can be efficiently precomputed.

Analytics must be designed around real business questions.

---

# 34. Analytics Events

Important business events should be usable by the analytics system.

Examples:

```text
CustomerRegistered
ProductViewed
ProductAddedToCart
CheckoutStarted
OrderCreated
PaymentCompleted
OrderCancelled
OrderDelivered
RefundCreated
```

Only track events that provide meaningful business value.

Do not create unnecessary analytics complexity.

---

# 35. Admin Dashboard

The admin dashboard should provide actionable information.

Examples:

```text
Sales Today
Sales This Week
Sales This Month

Orders Today
Pending Orders
Orders Awaiting Shipment

New Customers
Returning Customers

Top Products
Low Stock Products

Revenue Trend
Order Trend
Customer Trend
```

The dashboard should consume dedicated analytics APIs.

Avoid embedding complex analytics calculations directly in React components.

---

# 36. REST API

REST is the primary request/response mechanism.

Use consistent API conventions.

Example:

```text
GET    /api/products
GET    /api/products/:id
POST   /api/products
PATCH  /api/products/:id
DELETE /api/products/:id
```

Admin APIs may use:

```text
/api/admin/products
/api/admin/orders
/api/admin/customers
```

depending on the project's final API design.

Use appropriate HTTP status codes.

Maintain consistent response structures.

---

# 37. API Response Format

Where appropriate, use a consistent response structure.

Success:

```json
{
  "success": true,
  "data": {}
}
```

Error:

```json
{
  "success": false,
  "message": "Product not found"
}
```

The exact response contract should remain consistent across features.

Do not expose stack traces or internal implementation details in production responses.

---

# 38. Validation

All external input must be validated.

Frontend validation is for user experience.

Backend validation is mandatory for security and correctness.

Validate:

* Required fields
* Types
* Formats
* Lengths
* Ranges
* IDs
* Emails
* Business rules
* Permissions

Never trust:

* Client-provided prices
* Client-provided totals
* Client-provided inventory
* Client-provided permissions
* Client-provided roles

---

# 39. Error Handling

Use centralized error handling.

Errors should be:

* Predictable
* Safe
* Logged appropriately
* Useful to developers
* Appropriate for clients

Do not expose:

* Stack traces
* Database credentials
* Internal queries
* Secrets
* Private implementation details

---

# 40. Security

Security is a first-class requirement.

Never commit:

```text
.env
.env.local
.env.production
```

Never expose:

* Database passwords
* JWT secrets
* Supabase service-role credentials
* Email provider credentials
* Payment secrets
* Private API keys

Server-only credentials must never be sent to the client or admin frontend.

Use environment variables.

Apply authorization to all protected resources.

Validate external input.

Use secure token handling.

---

# 41. Environment Configuration

Environment-specific configuration belongs in environment variables.

Potential variables:

```text
NODE_ENV
PORT
DATABASE_URL

JWT_ACCESS_SECRET
JWT_REFRESH_SECRET

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

EMAIL_PROVIDER_API_KEY

PAYMENT_PROVIDER_SECRET
```

Only include variables actually required by the implementation.

Provide `.env.example`.

Never place real credentials inside `.env.example`.

---

# 42. Logging

Logging should support debugging and operations.

Useful events include:

* Authentication failures
* API errors
* Order processing failures
* Payment failures
* Worker failures
* Email failures
* External API failures
* Important business events
* Realtime infrastructure errors

Never log sensitive credentials or tokens.

Avoid excessive noisy logging.

---

# 43. Auditing

Important administrative operations should be auditable when appropriate.

Examples:

```text
Admin changed product price
Admin changed order status
Admin modified inventory
Admin updated customer status
Admin issued refund
```

An audit record may contain:

```text
Actor
Action
Resource
Resource ID
Previous Value
New Value
Timestamp
```

Do not implement auditing for every trivial operation unless required.

---

# 44. Concurrency and Race Conditions

Ecommerce systems must account for concurrent operations.

Important examples:

```text
Two customers purchase the last product
Two admins modify inventory
Payment webhook arrives twice
Order cancellation happens during fulfillment
Worker retries an already completed operation
```

Use appropriate:

* Transactions
* Locks
* Constraints
* Idempotency keys
* Unique constraints
* State validation

Do not assume requests will always execute sequentially.

---

# 45. Idempotency

Critical operations should be idempotent where necessary.

Especially:

* Payment operations
* Payment webhooks
* Order creation where retries are possible
* Inventory operations
* Background jobs
* External callbacks

A repeated request or webhook must not accidentally create duplicate side effects.

---

# 46. External Integrations

External services should be isolated behind clear interfaces/services.

Examples:

```text
PaymentProvider
EmailProvider
ShippingProvider
StorageProvider
```

Do not spread provider-specific code throughout the application.

Prefer:

```text
Business Logic
      ↓
Provider Interface
      ↓
Specific Provider
```

This makes future provider replacement easier.

---

# 47. Caching

Caching may be introduced where it provides a meaningful performance benefit.

Potential candidates:

* Product catalog data
* Analytics results
* Store settings
* Frequently accessed configuration

Do not cache transactional data blindly.

Always consider:

* Cache invalidation
* Stale data
* Consistency
* Memory usage

Do not introduce caching before identifying an actual need.

---

# 48. Performance

Performance should be considered from the beginning without premature optimization.

Pay particular attention to:

* Database indexes
* N+1 queries
* Large API responses
* Expensive analytics
* Image processing
* Background work
* Pagination
* Search
* Realtime event volume

Large collections must support pagination.

Do not return thousands of records unnecessarily.

---

# 49. Pagination

Collection endpoints should support pagination where appropriate.

For example:

```text
GET /api/products?page=1&limit=20
```

or another consistent pagination strategy.

The API should provide enough metadata for the frontend to understand:

* Current page
* Total records
* Total pages
* Next/previous availability

Use the same pagination strategy consistently.

---

# 50. Search and Filtering

Search and filtering should be handled efficiently.

Potential product filters:

* Category
* Price
* Availability
* Status
* SKU
* Search term

Potential order filters:

* Status
* Payment status
* Shipping status
* Customer
* Date range

Do not implement filtering by loading the entire database into application memory.

---

# 51. Frontend Architecture

Both frontend applications should use feature-oriented organization where appropriate.

Example:

```text
client/
└── features/
    ├── auth/
    ├── products/
    ├── cart/
    ├── checkout/
    ├── orders/
    └── account/
```

Admin:

```text
admin/
└── features/
    ├── auth/
    ├── dashboard/
    ├── customers/
    ├── products/
    ├── inventory/
    ├── orders/
    ├── shipping/
    ├── payments/
    ├── discounts/
    └── analytics/
```

Avoid huge components.

Keep API communication separated from presentation when practical.

---

# 52. Client Responsibilities

The client should handle:

* UI
* Navigation
* User interactions
* Forms
* Client-side validation
* Local UI state
* API communication
* Realtime UI updates

The client should NOT be responsible for:

* Authoritative pricing
* Inventory decisions
* Authorization
* Payment verification
* Order status authority
* Business-critical calculations

---

# 53. Admin Responsibilities

The admin application should handle:

* Store management UI
* Data tables
* Forms
* Filters
* Dashboard visualization
* Operational workflows
* Admin notifications
* Realtime dashboard updates

Business rules remain on the server.

---

# 54. Testing

Important business logic should be testable.

Prioritize tests for:

* Authentication
* Authorization
* Product operations
* Inventory
* Order creation
* Order totals
* Discounts
* Payment state transitions
* Shipping transitions
* Worker jobs
* Event handlers
* Critical API endpoints

Especially test edge cases.

Examples:

```text
Last item in inventory
Duplicate payment webhook
Invalid coupon
Expired coupon
Cancelled order
Already shipped order
Unauthorized admin request
Invalid refresh token
Worker retry
```

Do not only test successful scenarios.

---

# 55. Documentation

Important architectural decisions should be documented.

Recommended documentation:

```text
docs/
├── architecture.md
├── database.md
├── api.md
├── authentication.md
├── orders.md
├── inventory.md
├── shipping.md
├── payments.md
├── workers.md
├── realtime.md
└── analytics.md
```

Do not duplicate information unnecessarily between documentation files and code.

---

# 56. Git Rules

Use meaningful commits.

Examples:

```text
feat: add customer management
feat: implement product search
feat: add order processing workflow
feat: add email worker
feat: add realtime order notifications

fix: prevent negative inventory
fix: handle duplicate payment webhook

refactor: improve order service
```

Never commit:

```text
.env
node_modules/
dist/
build/
secrets
```

---

# 57. Single-Store Constraint

This system manages one store.

Do NOT introduce:

* Multi-tenancy
* Tenant IDs
* Merchant isolation
* Store isolation
* SaaS subscriptions
* Multiple merchant accounts
* Multiple independent stores

unless explicitly requested.

The architecture should be scalable without unnecessarily becoming a multi-tenant SaaS architecture.

---

# 58. Avoid Overengineering

This is extremely important.

The project should be architecturally strong, but complexity must be justified.

Do not introduce:

* Microservices
* Kubernetes
* Event buses
* Multiple databases
* Complex distributed systems
* Excessive abstractions
* Unnecessary caching
* Unnecessary queues

unless there is a clear requirement.

A modular monolith is preferred unless the project requirements clearly justify another architecture.

The backend should initially be a **well-structured modular monolith**.

---

# 59. Modular Monolith

The preferred backend architecture is:

```text
                Backend
                   │
        ┌──────────┼──────────┐
        │          │          │
     Products    Orders    Customers
        │          │          │
     Inventory  Shipping   Auth
        │          │          │
        └──────────┼──────────┘
                   │
              Shared Infrastructure
                   │
       ┌───────────┼───────────┐
       │           │           │
   Database      Queue      Realtime
                   │
                Workers
```

Features remain logically separated while running inside the same application.

This provides modularity without premature microservices complexity.

---

# 60. Shared Infrastructure

Infrastructure should be separated from business features.

Potential infrastructure:

```text
server/
├── infrastructure/
│   ├── database/
│   ├── queue/
│   ├── email/
│   ├── realtime/
│   ├── logging/
│   └── storage/
```

Infrastructure provides technical capabilities.

Features use those capabilities.

Do not put business rules inside infrastructure modules.

---

# 61. Background Worker Structure

A possible structure:

```text
server/
└── workers/
    ├── email/
    ├── notifications/
    ├── analytics/
    ├── reports/
    └── cleanup/
```

Workers should remain independently understandable.

Each worker should have clear:

* Input
* Processing logic
* Failure behavior
* Retry behavior
* Logging
* Idempotency requirements

---

# 62. Realtime Structure

A possible structure:

```text
server/
└── realtime/
    ├── socket.js
    ├── middleware/
    ├── handlers/
    ├── rooms/
    └── events/
```

Use rooms/channels when appropriate.

For example:

```text
admin
customer:{customerId}
order:{orderId}
```

Only expose information to authorized users.

---

# 63. Business Events + Workers + Realtime

These systems should work together.

Example:

```text
Order Created
      │
      ├───────────────┐
      │               │
      ▼               ▼
Database           Event
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       Email       Analytics    Realtime
       Worker        Worker      Event
          │           │           │
          ▼           ▼           ▼
      Customer      Metrics       Admin
      Email                       UI
```

This pattern should be used where appropriate.

Do not force every operation through this architecture.

---

# 64. Order Example

A typical successful order workflow may look like:

```text
Customer
   ↓
Checkout
   ↓
POST /orders
   ↓
Authenticate
   ↓
Validate request
   ↓
Load products
   ↓
Validate prices
   ↓
Validate inventory
   ↓
Calculate totals
   ↓
Create order transaction
   ↓
Reserve/decrease inventory
   ↓
Commit transaction
   ↓
Publish OrderCreated
   │
   ├── Email Worker
   ├── Analytics Worker
   ├── Notification
   └── Socket.IO
```

The exact implementation may differ based on payment and inventory strategy.

---

# 65. Claude's Development Workflow

When implementing a feature, follow this process.

## Step 1 — Understand

Inspect the existing codebase and requirements.

Do not immediately start writing code.

---

## Step 2 — Identify the Feature

Determine which domain owns the functionality.

Examples:

```text
Product → products
Order → orders
Stock → inventory
Shipment → shipping
```

---

## Step 3 — Check Dependencies

Determine which other domains are affected.

For example:

```text
Order
→ Inventory
→ Payment
→ Shipping
→ Notifications
→ Analytics
```

---

## Step 4 — Design

Before major implementation, consider:

* Database changes
* API changes
* Business rules
* Transactions
* Events
* Workers
* Realtime updates
* Analytics
* Security
* Testing

---

## Step 5 — Implement

Implement the smallest complete solution that follows the architecture.

Do not implement fake placeholders when real functionality is expected.

---

## Step 6 — Integrate

Ensure the feature works across:

```text
Database
API
Business Logic
Workers
Events
Realtime
Client
Admin
```

where applicable.

---

## Step 7 — Test

Test:

* Happy path
* Validation failures
* Authorization failures
* Edge cases
* Database failures
* External service failures
* Worker retries
* Duplicate events/webhooks

---

## Step 8 — Review

Before finishing:

* Check for security issues.
* Check for race conditions.
* Check for duplicated logic.
* Check for unnecessary dependencies.
* Check API consistency.
* Check database integrity.
* Check worker idempotency.
* Check realtime authorization.

---

# 66. Claude Must Inspect Before Modifying

Before modifying existing code:

1. Inspect the relevant files.
2. Understand existing patterns.
3. Search for existing implementations.
4. Check related services.
5. Check related APIs.
6. Check database relationships.
7. Check tests.
8. Check configuration.

Do not create a duplicate implementation without checking whether one already exists.

---

# 67. Claude Must Avoid Unnecessary Changes

When implementing a feature:

* Do not rewrite unrelated modules.
* Do not rename unrelated files.
* Do not replace working libraries without reason.
* Do not restructure the entire project for a small feature.
* Do not change API contracts unnecessarily.
* Do not introduce breaking changes silently.

Keep changes focused.

---

# 68. Architectural Decision Making

When a major architectural decision is required, Claude should consider:

1. Correctness
2. Security
3. Data consistency
4. Reliability
5. Maintainability
6. Performance
7. Scalability
8. Developer experience

Do not choose an architecture merely because it is technically impressive.

Choose the simplest architecture that satisfies the requirement.

---

# 69. Requirements Ambiguity

If a requirement is ambiguous and the decision significantly affects:

* Database schema
* Security
* Authentication
* Payment
* Inventory
* Order lifecycle
* Architecture
* Data consistency

do not silently make a major assumption.

Clearly identify the ambiguity and propose the most reasonable approach.

For minor implementation details, make a sensible decision and continue.

---

# 70. Production Quality

"Fully functional" means:

* Real database operations
* Real validation
* Real authentication
* Real authorization
* Real error handling
* Real business logic
* Real background processing
* Real email integration where configured
* Real realtime integration where required
* Real analytics
* Proper transactions
* Proper failure handling
* Proper API responses
* Tests for critical functionality

Do not consider a feature complete merely because the endpoint returns a successful response.

---

# 71. Definition of Done

A feature is considered complete when appropriate:

```text
[ ] Database changes implemented
[ ] Migration implemented
[ ] Validation implemented
[ ] Authorization implemented
[ ] Service/business logic implemented
[ ] API implemented
[ ] Error handling implemented
[ ] Background processing implemented if required
[ ] Events implemented if required
[ ] Realtime updates implemented if required
[ ] Email/notification integration implemented if required
[ ] Analytics integration implemented if required
[ ] Tests implemented
[ ] Documentation updated
[ ] Security reviewed
[ ] Edge cases considered
```

Not every item is mandatory for every feature.

Only apply the relevant items.

---

# 72. Final Architectural Rule

Always remember:

```text
Feature-Based Architecture
        +
Modular Monolith
        +
REST APIs
        +
PostgreSQL
        +
Background Workers
        +
Events
        +
Email System
        +
Socket.IO Realtime
        +
Analytics
        +
Strong Security
        +
Reliable Transactions
```

These are the core architectural principles of this Ecommerce platform.

Build the system as a coherent product, not as disconnected CRUD modules.

Prioritize correctness, security, maintainability, and data consistency.

Use complexity only when it provides a real benefit.

When in doubt, inspect the existing architecture first and extend it consistently rather than introducing a competing pattern.
