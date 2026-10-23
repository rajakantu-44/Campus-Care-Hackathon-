<?php
declare(strict_types=1);

/*
 * Shared application services for the CampusCare PHP API.
 * The collection names and BSON document fields intentionally match the
 * previous API, so this application reads the existing database unchanged.
 */

use MongoDB\BSON\ObjectId;
use MongoDB\BSON\Regex;
use MongoDB\BSON\UTCDateTime;
use MongoDB\Driver\BulkWrite;
use MongoDB\Driver\Command;
use MongoDB\Driver\Exception\BulkWriteException;
use MongoDB\Driver\Manager;
use MongoDB\Driver\Query;

const STATUSES = ['Submitted', 'Under Review', 'In Progress', 'Resolved'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const DEPARTMENTS = [
    'Maintenance' => 'complaints_maintenance',
    'IT' => 'complaints_it',
    'Student Affairs' => 'complaints_student_affairs',
    'Housekeeping' => 'complaints_housekeeping',
    'General Administration' => 'complaints_general_administration',
];
const STALE_COMPLAINT_DAYS = 30;

final class HttpError extends RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

function load_environment(): void
{
    static $loaded = false;
    if ($loaded) {
        return;
    }
    $loaded = true;
    $file = dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env';
    if (!is_file($file)) {
        return;
    }
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value);
        if (($value[0] ?? '') === '"' && str_ends_with($value, '"')) {
            $value = substr($value, 1, -1);
        }
        if ($key !== '' && getenv($key) === false) {
            putenv("{$key}={$value}");
            $_ENV[$key] = $value;
        }
    }
}

function env_value(string $key, string $default = ''): string
{
    load_environment();
    $value = getenv($key);
    return $value === false ? $default : (string) $value;
}

function require_mongodb_extension(): void
{
    if (!class_exists(Manager::class)) {
        throw new RuntimeException('The mongodb PHP extension is required. Enable extension=mongodb in php.ini.');
    }
}

function database_name(): string
{
    $path = (string) parse_url(env_value('MONGO_URI', 'mongodb://localhost:27017/campuscare'), PHP_URL_PATH);
    $name = trim($path, '/');
    return $name === '' ? 'campuscare' : explode('/', $name)[0];
}

function mongo(): Manager
{
    static $manager = null;
    if ($manager instanceof Manager) {
        return $manager;
    }
    require_mongodb_extension();
    $manager = new Manager(env_value('MONGO_URI', 'mongodb://localhost:27017/campuscare'));
    return $manager;
}

function namespace_for(string $collection): string
{
    return database_name() . '.' . $collection;
}

function mongo_find(string $collection, array $filter = [], array $options = []): array
{
    $cursor = mongo()->executeQuery(namespace_for($collection), new Query($filter, $options));
    $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
    return $cursor->toArray();
}

function mongo_find_one(string $collection, array $filter): ?array
{
    $records = mongo_find($collection, $filter, ['limit' => 1]);
    return $records[0] ?? null;
}

function mongo_insert_one(string $collection, array $document): mixed
{
    $bulk = new BulkWrite();
    $insertedId = $bulk->insert($document);
    mongo()->executeBulkWrite(namespace_for($collection), $bulk);
    return $insertedId;
}

function mongo_update_one(string $collection, array $filter, array $update, bool $upsert = false): int
{
    $bulk = new BulkWrite();
    $bulk->update($filter, $update, ['multi' => false, 'upsert' => $upsert]);
    $result = mongo()->executeBulkWrite(namespace_for($collection), $bulk);
    return $result->getModifiedCount();
}

function mongo_update_many(string $collection, array $filter, array $update): int
{
    $bulk = new BulkWrite();
    $bulk->update($filter, $update, ['multi' => true, 'upsert' => false]);
    $result = mongo()->executeBulkWrite(namespace_for($collection), $bulk);
    return $result->getModifiedCount();
}

function mongo_delete_one(string $collection, array $filter): void
{
    $bulk = new BulkWrite();
    $bulk->delete($filter, ['limit' => 1]);
    mongo()->executeBulkWrite(namespace_for($collection), $bulk);
}

function mongo_delete_many(string $collection, array $filter): void
{
    $bulk = new BulkWrite();
    $bulk->delete($filter, ['limit' => 0]);
    mongo()->executeBulkWrite(namespace_for($collection), $bulk);
}

function mongo_command(string $database, array $command): array
{
    return mongo()->executeCommand($database, new Command($command))->toArray();
}

function collection_for_department(string $department): string
{
    return DEPARTMENTS[$department] ?? DEPARTMENTS['General Administration'];
}

function now_utc(): UTCDateTime
{
    return new UTCDateTime((int) floor(microtime(true) * 1000));
}

function iso_date(mixed $date): string
{
    if ($date instanceof UTCDateTime) {
        return $date->toDateTime()->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }
    if ($date instanceof DateTimeInterface) {
        return $date->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }
    return '';
}

function epoch_milliseconds(mixed $date): int
{
    if ($date instanceof UTCDateTime) {
        return (int) $date->toDateTime()->format('Uv');
    }
    if ($date instanceof DateTimeInterface) {
        return (int) $date->format('Uv');
    }
    return 0;
}

function create_indexes(): void
{
    foreach (['administration', 'student'] as $collection) {
        mongo_command(database_name(), [
            'createIndexes' => $collection,
            'indexes' => [
                ['key' => ['email' => 1], 'name' => 'email_1', 'unique' => true],
                ['key' => ['roll_or_employee_id' => 1], 'name' => 'roll_or_employee_id_1', 'unique' => true],
            ],
        ]);
    }
    foreach (array_values(DEPARTMENTS) as $collection) {
        mongo_command(database_name(), [
            'createIndexes' => $collection,
            'indexes' => [
                ['key' => ['complaint_id' => 1], 'name' => 'complaint_id_1', 'unique' => true],
                ['key' => ['user_id' => 1, 'created_at' => -1], 'name' => 'user_id_1_created_at_-1'],
                ['key' => ['status' => 1], 'name' => 'status_1'],
                ['key' => ['status_updated_at' => 1], 'name' => 'status_updated_at_1'],
            ],
        ]);
    }
    mongo_command(database_name(), [
        'createIndexes' => 'notifications',
        'indexes' => [
            ['key' => ['user_id' => 1, 'created_at' => -1], 'name' => 'user_id_1_created_at_-1'],
            ['key' => ['dedupe_key' => 1], 'name' => 'dedupe_key_1', 'unique' => true, 'sparse' => true],
        ],
    ]);
}

function user_collection(string $role): string
{
    return in_array($role, ['admin', 'department_admin'], true) ? 'administration' : 'student';
}

function find_user_by_id(ObjectId $id): ?array
{
    return mongo_find_one('administration', ['_id' => $id])
        ?? mongo_find_one('student', ['_id' => $id]);
}

function find_user_by_identifier(string $identifier): ?array
{
    $filter = ['$or' => [
        ['roll_or_employee_id' => new Regex('^' . preg_quote($identifier, '/') . '$', 'i')],
        ['email' => strtolower($identifier)],
    ]];
    return mongo_find_one('administration', $filter) ?? mongo_find_one('student', $filter);
}

function is_super_admin(array $user): bool
{
    return ($user['role'] ?? '') === 'admin'
        && strtoupper(trim((string) ($user['roll_or_employee_id'] ?? ''))) === 'ADMIN-001';
}

function safe_user(array $user): array
{
    return [
        'id' => (string) $user['_id'],
        'name' => (string) $user['name'],
        'roll_or_employee_id' => (string) $user['roll_or_employee_id'],
        'email' => (string) $user['email'],
        'role' => (string) $user['role'],
        'department' => $user['department'] ?? null,
        'is_super_admin' => is_super_admin($user),
        'created_at' => iso_date($user['created_at'] ?? null),
    ];
}

function base64url_encode(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function base64url_decode(string $value): string|false
{
    $padding = strlen($value) % 4;
    if ($padding !== 0) {
        $value .= str_repeat('=', 4 - $padding);
    }
    return base64_decode(strtr($value, '-_', '+/'), true);
}

function make_token(array $user): string
{
    $now = time();
    $header = base64url_encode(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR));
    $payload = base64url_encode(json_encode([
        'sub' => (string) $user['_id'],
        'role' => $user['role'],
        'iat' => $now,
        'exp' => $now + (24 * 60 * 60),
    ], JSON_THROW_ON_ERROR));
    $signature = base64url_encode(hash_hmac('sha256', "{$header}.{$payload}", env_value('JWT_SECRET', 'development-secret'), true));
    return "{$header}.{$payload}.{$signature}";
}

function token_payload(string $token): array
{
    $parts = explode('.', $token);
    if (count($parts) !== 3) {
        throw new HttpError(401, 'Your session is invalid or expired. Please log in again.');
    }
    [$header, $payload, $signature] = $parts;
    $expected = base64url_encode(hash_hmac('sha256', "{$header}.{$payload}", env_value('JWT_SECRET', 'development-secret'), true));
    if (!hash_equals($expected, $signature)) {
        throw new HttpError(401, 'Your session is invalid or expired. Please log in again.');
    }
    try {
        $decoded = json_decode((string) base64url_decode($payload), true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable) {
        throw new HttpError(401, 'Your session is invalid or expired. Please log in again.');
    }
    if (!is_array($decoded) || !isset($decoded['sub'], $decoded['exp']) || (int) $decoded['exp'] < time()) {
        throw new HttpError(401, 'Your session is invalid or expired. Please log in again.');
    }
    return $decoded;
}

function authorization_header(): string
{
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    return (string) ($headers['Authorization'] ?? $headers['authorization'] ?? $_SERVER['HTTP_AUTHORIZATION'] ?? '');
}

function current_user(): array
{
    $header = authorization_header();
    if (!str_starts_with($header, 'Bearer ')) {
        throw new HttpError(401, 'Authentication token is required.');
    }
    $payload = token_payload(substr($header, 7));
    try {
        $user = find_user_by_id(new ObjectId((string) $payload['sub']));
    } catch (Throwable) {
        $user = null;
    }
    if (!$user) {
        throw new HttpError(401, 'Your session is invalid or expired. Please log in again.');
    }
    return $user;
}

function require_roles(array $roles): array
{
    $user = current_user();
    if (!in_array($user['role'], $roles, true)) {
        throw new HttpError(403, 'You do not have permission to access this resource.');
    }
    return $user;
}

function require_super_admin(): array
{
    $user = current_user();
    if (!is_super_admin($user)) {
        throw new HttpError(403, 'Only Admin-001 can access this resource.');
    }
    return $user;
}

function require_dashboard_user(): array
{
    $user = current_user();
    if (!is_super_admin($user) && ($user['role'] ?? '') !== 'department_admin') {
        throw new HttpError(403, 'You do not have permission to access this resource.');
    }
    return $user;
}

function accessed_department(array $user, string $requestedDepartment = ''): string
{
    if (is_super_admin($user)) {
        if (!array_key_exists($requestedDepartment, DEPARTMENTS)) {
            throw new HttpError(400, 'Choose a valid department.');
        }
        return $requestedDepartment;
    }
    if (($user['role'] ?? '') === 'department_admin' && isset($user['department'])) {
        return (string) $user['department'];
    }
    throw new HttpError(403, 'You do not have permission to access this resource.');
}

function classify_complaint(string $text, string $category = ''): array
{
    $phrase = strtolower("{$text} {$category}");
    foreach (['exposed wire', 'exposed electrical wire', 'live wire', 'electric shock', 'fire', 'gas leak', 'unsafe', 'hazard'] as $word) {
        if (str_contains($phrase, $word)) return ['department' => 'Maintenance', 'priority' => 'Critical'];
    }
    foreach (['wifi', 'wi-fi', 'internet', 'network', 'computer', 'projector', 'software', 'website'] as $word) {
        if (str_contains($phrase, $word)) return ['department' => 'IT', 'priority' => 'High'];
    }
    foreach (['broken fan', 'fan', 'light', 'bench', 'chair', 'leak', 'plumbing', 'toilet', 'electrical'] as $word) {
        if (str_contains($phrase, $word)) return ['department' => 'Maintenance', 'priority' => 'Medium'];
    }
    foreach (['harassment', 'bullying', 'security', 'theft', 'violence'] as $word) {
        if (str_contains($phrase, $word)) return ['department' => 'Student Affairs', 'priority' => 'High'];
    }
    foreach (['clean', 'garbage', 'washroom', 'waste'] as $word) {
        if (str_contains($phrase, $word)) return ['department' => 'Housekeeping', 'priority' => 'Medium'];
    }
    return ['department' => 'General Administration', 'priority' => 'Medium'];
}

function all_complaints(array $filter = []): array
{
    $records = [];
    foreach (array_values(DEPARTMENTS) as $collection) {
        array_push($records, ...mongo_find($collection, $filter));
    }
    usort($records, static fn (array $a, array $b): int => epoch_milliseconds($b['created_at'] ?? null) <=> epoch_milliseconds($a['created_at'] ?? null));
    return $records;
}

function find_complaint(string $complaintId): array
{
    foreach (array_values(DEPARTMENTS) as $collection) {
        $complaint = mongo_find_one($collection, ['complaint_id' => $complaintId]);
        if ($complaint) {
            return [$complaint, $collection];
        }
    }
    return [null, null];
}

function complaint_output(array $complaint, ?string $reporterName = null, ?string $reporterId = null, bool $revealIdentity = false): array
{
    $status = (string) ($complaint['status'] ?? 'Submitted');
    $statusIndex = array_search($status, STATUSES, true);
    if ($statusIndex === false) $statusIndex = 0;
    $timeline = [];
    foreach (STATUSES as $index => $label) {
        $timeline[] = ['label' => $label, 'state' => $index < $statusIndex ? 'complete' : ($index === $statusIndex ? 'current' : 'upcoming')];
    }
    return [
        'complaint_id' => (string) $complaint['complaint_id'],
        'title' => (string) $complaint['title'],
        'description' => (string) $complaint['description'],
        'category' => (string) $complaint['category'],
        'location' => (string) $complaint['location'],
        'priority' => (string) $complaint['priority'],
        'department' => (string) $complaint['department'],
        'image' => $complaint['image'] ?? null,
        'image_url' => empty($complaint['image']) ? null : '/uploads/' . rawurlencode((string) $complaint['image']),
        'anonymous' => (bool) ($complaint['anonymous'] ?? false),
        'submitted_by' => $revealIdentity ? ($reporterName ?: 'CampusCare user') : ((bool) ($complaint['anonymous'] ?? false) ? 'Anonymous' : 'CampusCare user'),
        'submitted_roll_or_employee_id' => $revealIdentity ? $reporterId : null,
        'status' => $status,
        'resolution_note' => (string) ($complaint['resolution_note'] ?? ''),
        'created_at' => iso_date($complaint['created_at'] ?? null),
        'updated_at' => iso_date($complaint['updated_at'] ?? null),
        'timeline' => $timeline,
    ];
}

function next_complaint_id(): string
{
    $reply = mongo_command(database_name(), [
        'findAndModify' => 'counters',
        'query' => ['_id' => 'complaint_counter'],
        'update' => ['$inc' => ['sequence' => 1]],
        'upsert' => true,
        'new' => true,
    ]);
    $value = (array) ($reply[0]->value ?? []);
    return 'CC-' . (1000 + (int) ($value['sequence'] ?? 1));
}

function notification_output(array $notification): array
{
    return [
        'id' => (string) $notification['_id'],
        'kind' => (string) $notification['kind'],
        'message' => (string) $notification['message'],
        'complaint_id' => $notification['complaint_id'] ?? null,
        'read' => (bool) ($notification['read'] ?? false),
        'created_at' => iso_date($notification['created_at'] ?? null),
    ];
}

function create_notification(ObjectId $userId, string $kind, string $message, ?string $complaintId = null, ?string $dedupeKey = null): bool
{
    $notification = [
        'user_id' => $userId,
        'kind' => $kind,
        'message' => $message,
        'complaint_id' => $complaintId,
        'read' => false,
        'created_at' => now_utc(),
    ];
    if ($dedupeKey !== null) $notification['dedupe_key'] = $dedupeKey;
    try {
        mongo_insert_one('notifications', $notification);
        return true;
    } catch (BulkWriteException $error) {
        foreach ($error->getWriteResult()->getWriteErrors() as $writeError) {
            if ($writeError->getCode() === 11000) return false;
        }
        throw $error;
    }
}

function check_stale_complaints(): int
{
    $masterAdmin = mongo_find_one('administration', ['roll_or_employee_id' => 'ADMIN-001']);
    if (!$masterAdmin) return 0;
    $now = (int) floor(microtime(true) * 1000);
    $created = 0;
    foreach (all_complaints(['status' => ['$ne' => 'Resolved']]) as $complaint) {
        $lastStatusChange = $complaint['status_updated_at'] ?? $complaint['updated_at'] ?? $complaint['created_at'] ?? null;
        $lastMs = epoch_milliseconds($lastStatusChange);
        if ($lastMs === 0 || $now - $lastMs < STALE_COMPLAINT_DAYS * 24 * 60 * 60 * 1000) continue;
        $key = sprintf('stale_complaint:%s:%s', $complaint['complaint_id'], iso_date($lastStatusChange));
        if (create_notification(
            $masterAdmin['_id'],
            'stale_complaint',
            "{$complaint['complaint_id']} has had no status change for 30 days and needs attention from {$complaint['department']}.",
            $complaint['complaint_id'],
            $key,
        )) {
            $created++;
        }
    }
    return $created;
}

function ensure_account_seeds(): void
{
    $seeds = [];
    $adminEmail = strtolower(trim(env_value('ADMIN_EMAIL')));
    $adminPassword = env_value('ADMIN_PASSWORD');
    if ($adminEmail !== '' && $adminPassword !== '') {
        $seeds[] = ['name' => env_value('ADMIN_NAME', 'CampusCare Administrator'), 'id' => 'ADMIN-001', 'email' => $adminEmail, 'password' => $adminPassword, 'role' => 'admin'];
    }
    foreach ([
        ['Maintenance', 'Maintenance Admin', 'MAINT-001', 'maintenance-admin@campuscare.local', 'MAINTENANCE_ADMIN_PASSWORD'],
        ['IT', 'IT Admin', 'IT-001', 'it-admin@campuscare.local', 'IT_ADMIN_PASSWORD'],
        ['Student Affairs', 'Student Affairs Admin', 'STUAFF-001', 'student-affairs-admin@campuscare.local', 'STUDENT_AFFAIRS_ADMIN_PASSWORD'],
        ['Housekeeping', 'Housekeeping Admin', 'HOUSEKEEP-001', 'housekeeping-admin@campuscare.local', 'HOUSEKEEPING_ADMIN_PASSWORD'],
        ['General Administration', 'General Administration Admin', 'GENADMIN-001', 'general-admin@campuscare.local', 'GENERAL_ADMIN_PASSWORD'],
    ] as [$department, $name, $identifier, $email, $passwordKey]) {
        $password = env_value($passwordKey);
        if ($password !== '') $seeds[] = ['name' => $name, 'id' => $identifier, 'email' => $email, 'password' => $password, 'role' => 'department_admin', 'department' => $department];
    }
    foreach ($seeds as $seed) {
        if (find_user_by_identifier($seed['id']) || find_user_by_identifier($seed['email'])) continue;
        $account = [
            'name' => $seed['name'],
            'roll_or_employee_id' => $seed['id'],
            'email' => $seed['email'],
            'password_hash' => password_hash($seed['password'], PASSWORD_BCRYPT),
            'role' => $seed['role'],
            'created_at' => now_utc(),
        ];
        if (isset($seed['department'])) $account['department'] = $seed['department'];
        mongo_insert_one('administration', $account);
    }
}

function json_input(): array
{
    $body = file_get_contents('php://input');
    if ($body === false || trim($body) === '') return [];
    try {
        $data = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable) {
        throw new HttpError(400, 'Request body must be valid JSON.');
    }
    return is_array($data) ? $data : [];
}

function request_value(array $source, string $key): string
{
    return trim((string) ($source[$key] ?? ''));
}

function document_without_id(array $document): array
{
    unset($document['_id']);
    return $document;
}
