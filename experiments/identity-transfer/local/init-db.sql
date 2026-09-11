-- GoTrue runs its own migrations but does not create the schema they live in:
-- with search_path=auth and no such schema, the first CREATE TABLE fails with
-- SQLSTATE 3F000 "no schema has been selected to create in".
create schema if not exists auth;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
