<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

try {
    create_indexes();
    ensure_account_seeds();
    echo "MongoDB indexes verified and missing configured accounts created." . PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, "Setup failed: {$error->getMessage()}" . PHP_EOL);
    exit(1);
}
