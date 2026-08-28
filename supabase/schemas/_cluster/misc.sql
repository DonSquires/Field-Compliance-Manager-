select cron.schedule_in_database('bob-gitea-sync-every-5m', '*/5 * * * *', 'select ops.enqueue_bob_gitea_sync(false, ''cron'');', 'postgres', null, false);
