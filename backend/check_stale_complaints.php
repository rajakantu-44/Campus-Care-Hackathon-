<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

try {
    create_indexes();
    ensure_account_seeds();
    $created = check_stale_complaints();
    echo "Created {$created} overdue complaint notification(s)." . PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, "Stale complaint check failed: {$error->getMessage()}" . PHP_EOL);
    exit(1);
}
