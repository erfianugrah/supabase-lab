-- Remove what query_history.sql installed. Safe to run when it is not installed.
select cron.unschedule(jobid) from cron.job where jobname = 'rca-snap';
drop schema if exists rca cascade;
