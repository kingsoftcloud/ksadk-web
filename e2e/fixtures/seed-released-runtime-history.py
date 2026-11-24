"""Seed the two sessions consumed by released-runtime-history.spec.ts.

Run with the current SDK in a disposable PostgreSQL database. Point both
KSADK_TEST_POSTGRES_DSN and KSADK_HISTORY_FIXTURE_NAMESPACE at the same
database and namespace used by the Runtime under test. Use a fresh namespace.
Then set KSADK_RELEASED_RUNTIME_FACADE to its local Server and run
npx playwright test -c playwright.released-runtime-history.config.mjs.
"""
import asyncio
import os

from ksadk.sessions._postgres_tables import KSADK_PG_EVENTS_TABLE
from ksadk.sessions.postgres_service import PostgresSessionService


async def main():
    namespace = os.environ["KSADK_HISTORY_FIXTURE_NAMESPACE"]
    service = PostgresSessionService(dsn=os.environ["KSADK_TEST_POSTGRES_DSN"], namespace=namespace)
    try:
        for session in ("local-heavy-A", "local-heavy-B"):
            if await service.get_session(session) is not None:
                raise ValueError(f"Use a fresh fixture namespace; {session} already exists")
        for session in ("local-heavy-A", "local-heavy-B"):
            await service.create_session("local-heavy-history", "user", session)
        async with service._connection(write=True) as connection:
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
    finally:
        await service.aclose()


if __name__ == "__main__":
    asyncio.run(main())
