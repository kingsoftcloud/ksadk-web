"""Seed the four sessions consumed by released-runtime-history.spec.ts.

Run with the SDK under test in a disposable PostgreSQL database. Point both
KSADK_TEST_POSTGRES_DSN and KSADK_HISTORY_FIXTURE_NAMESPACE at the same
database and namespace used by the Runtime under test. Use a fresh namespace.
Then set KSADK_RELEASED_RUNTIME_FACADE to its local Server and run
npx playwright test -c playwright.released-runtime-history.config.mjs.
"""
import argparse
import asyncio
import json
import os

from contextlib import asynccontextmanager

import asyncpg

from ksadk.sessions.postgres_service import KSADK_PG_EVENTS_TABLE, PostgresSessionService


@asynccontextmanager
async def fixture_connection():
    # Each SDK creates its own schema via create_session. Only use columns
    # that were present in v0.8.0 when populating the large synthetic history.
    connection = await asyncpg.connect(os.environ["KSADK_TEST_POSTGRES_DSN"])
    try:
        async with connection.transaction():
            yield connection
    finally:
        await connection.close()


async def seed_deferred_tool(service, namespace):
    session = "local-heavy-D"
    if await service.get_session(session) is not None:
        raise ValueError(f"Use a fresh fixture namespace; {session} already exists")
    await service.create_session("local-heavy-history", "user", session)
    async with fixture_connection() as connection:
        await connection.execute(f"""
            INSERT INTO {KSADK_PG_EVENTS_TABLE}
                (namespace,session_id,id,author,event_type,content_json,metadata_json,timestamp,seq_id,invocation_id)
            SELECT $1,$2,'deferred-'||n,CASE WHEN n=1 THEN 'user' WHEN n=61 THEN 'tool' ELSE 'assistant' END,
                   CASE n WHEN 1 THEN 'user_message' WHEN 2 THEN 'tool_call' WHEN 61 THEN 'tool_result'
                        WHEN 62 THEN 'assistant_message' ELSE 'progress' END,
                   jsonb_build_object('parts', jsonb_build_array(jsonb_build_object('text',
                        CASE n WHEN 1 THEN 'deferred-user-question' WHEN 62 THEN 'deferred-final-answer' ELSE '' END))),
                   CASE n WHEN 2 THEN jsonb_build_object('tool_name','large_lookup','tool_call_id','large-call',
                                  'tool_args',jsonb_build_object('query','deferred-question'))
                          WHEN 61 THEN jsonb_build_object('tool_name','large_lookup','tool_call_id','large-call',
                                  'tool_output',repeat('结果',110000)||'DEFERRED_TOOL_END')
                          ELSE '{{}}'::jsonb END,
                   n,n,'deferred-run' FROM generate_series(1,62) n
        """, namespace, session)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deferred-only", action="store_true", help="Add only session D to an existing fixture namespace")
    deferred_only = parser.parse_args().deferred_only
    namespace = os.environ["KSADK_HISTORY_FIXTURE_NAMESPACE"]
    service = PostgresSessionService(dsn=os.environ["KSADK_TEST_POSTGRES_DSN"], namespace=namespace)
    try:
        if deferred_only:
            await seed_deferred_tool(service, namespace)
            return
        for session in ("local-heavy-A", "local-heavy-B", "local-heavy-C"):
            if await service.get_session(session) is not None:
                raise ValueError(f"Use a fresh fixture namespace; {session} already exists")
        for session in ("local-heavy-A", "local-heavy-B", "local-heavy-C"):
            await service.create_session("local-heavy-history", "user", session)
        async with fixture_connection() as connection:
            await connection.execute(f"""
                INSERT INTO {KSADK_PG_EVENTS_TABLE}
                    (namespace,session_id,id,author,event_type,content_json,timestamp,seq_id,invocation_id)
                SELECT $1,'local-heavy-A','item-'||n,CASE WHEN n=1 THEN 'user' ELSE 'assistant' END,
                       CASE WHEN n=1 THEN 'user_message' WHEN n=17328 THEN 'assistant_message'
                            ELSE 'progress' END,
                       jsonb_build_object('parts',jsonb_build_array(jsonb_build_object('text','browser-marker-'||n))),
                       n,n,'one-run' FROM generate_series(1,17328) n
            """, namespace)
            await connection.execute(f"""
                INSERT INTO {KSADK_PG_EVENTS_TABLE}
                    (namespace,session_id,id,author,event_type,content_json,timestamp,seq_id,invocation_id)
                SELECT $1,'local-heavy-B','ordinary-'||n,CASE WHEN n%2=1 THEN 'user' ELSE 'assistant' END,
                       CASE WHEN n%2=1 THEN 'user_message' ELSE 'assistant_message' END,
                       jsonb_build_object('parts',jsonb_build_array(jsonb_build_object('text','ordinary-marker-'||n))),
                       CASE WHEN n=120 THEN 122 ELSE n END,CASE WHEN n=120 THEN 122 ELSE n END,'ordinary-'||((n+1)/2)
                FROM generate_series(1,120) n
            """, namespace)
            await connection.execute(f"""
                INSERT INTO {KSADK_PG_EVENTS_TABLE}
                    (namespace,session_id,id,author,event_type,content_json,metadata_json,timestamp,seq_id,invocation_id)
                SELECT $1,'local-heavy-B',kind,'assistant',kind,'{{}}'::jsonb,
                       jsonb_build_object('tool_name','example_lookup','tool_call_id','lookup-id',
                                          'tool_args',jsonb_build_object('key','q'),
                                          'tool_result',jsonb_build_object('value','compatibility-tool-end')),
                       seq,seq,'ordinary-60' FROM (VALUES (120,'tool_call'),(121,'tool_result')) AS t(seq,kind)
            """, namespace)
            # One physical invocation. Both lookups start on separate pages
            # and finish in reverse order. The middle answer is durable before
            # either result. Match by the old SDK's physical tool_call_id.
            await connection.execute(f"""
                INSERT INTO {KSADK_PG_EVENTS_TABLE}
                    (namespace,session_id,id,author,event_type,content_json,metadata_json,timestamp,seq_id,invocation_id)
                SELECT $1,'local-heavy-C','rich-'||n,'assistant','progress',
                       jsonb_build_object('parts',jsonb_build_array(jsonb_build_object('text','rich-progress-'||n))),
                       jsonb_build_object('provider_progress', repeat(md5(n::text), 38)),
                       CASE WHEN n BETWEEN 17200 AND 17290 THEN n-200 ELSE n END,n,'rich-run' FROM generate_series(1,17328) n
            """, namespace)
            markers = [
                (1, 'user', 'user_message', 'rich-user-opening', {}),
                (2, 'assistant', 'reasoning', 'rich-reasoning-opening', {'reasoning': 'rich-reasoning-opening'}),
                (3, 'assistant', 'assistant_message', 'rich-model-opening', {}),
                (17194, 'assistant', 'assistant_message', 'rich-model-before-tools', {}),
                (17199, 'assistant', 'tool_call', '', {'tool_name': 'example_lookup', 'tool_call_id': 'lookup-A',
                    'tool_args': {'term': 'rich-argument-A'}}),
                (17232, 'assistant', 'tool_call', '', {'tool_name': 'example_lookup', 'tool_call_id': 'lookup-B',
                    'tool_args': {'term': 'rich-argument-B'}}),
                (17235, 'assistant', 'assistant_message', 'rich-model-during-tools', {}),
                (17282, 'tool', 'tool_result', '', {'tool_name': 'example_lookup',
                    'tool_call_id': 'lookup-B', 'tool_receipt': {'tool_call_id': 'lookup-B'}, 'tool_output': {'value': 'rich-result-B'}, 'tool_is_error': True}),
                (17283, 'tool', 'tool_result', '', {'tool_name': 'example_lookup',
                    'tool_call_id': 'lookup-A', 'tool_receipt': {'tool_call_id': 'lookup-A'}, 'tool_output': {'value': 'rich-result-A'}}),
                (17284, 'assistant', 'reasoning', 'rich-reasoning-ending', {'reasoning': 'rich-reasoning-ending'}),
                (17285, 'assistant', 'assistant_message', 'rich-model-after-tools', {}),
                (17328, 'assistant', 'assistant_message', 'rich-model-final', {}),
            ]
            await connection.executemany(f"""
                UPDATE {KSADK_PG_EVENTS_TABLE}
                SET author=$2, event_type=$3, content_json=$4::jsonb, metadata_json=$5::jsonb
                WHERE namespace=$1 AND session_id='local-heavy-C' AND seq_id=$6
            """, [(namespace, author, kind, json.dumps({'role': 'user' if author == 'user' else 'model',
                'parts': [{'text': text}] if text else []}), json.dumps(metadata), seq)
                for seq, author, kind, text, metadata in markers])
        await seed_deferred_tool(service, namespace)
    finally:
        await service.aclose()


if __name__ == "__main__":
    asyncio.run(main())
