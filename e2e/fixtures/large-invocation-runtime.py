"""Real items-v1 Runtime backed by the caller's disposable PostgreSQL database."""
import asyncio
import os
import uuid

import uvicorn

from ksadk.server.composition import configure_runtime_app
from ksadk.server.factory import RuntimeAppConfig, create_runtime_app
from ksadk.sessions._postgres_tables import KSADK_PG_EVENTS_TABLE
from ksadk.sessions.postgres_service import PostgresSessionService


async def main():
    session_id = "local-heavy-A"
    service = PostgresSessionService(
        dsn=os.environ["KSADK_TEST_POSTGRES_DSN"], namespace=f"browser_{uuid.uuid4().hex}",
    )
    try:
        await service.create_session("local-heavy-history", "user", session_id)
        async with service._connection(write=True) as connection:
            await connection.execute(f"""
                INSERT INTO {KSADK_PG_EVENTS_TABLE}
                    (namespace, session_id, id, author, event_type, content_json,
                     timestamp, seq_id, invocation_id)
                SELECT $1, $2, 'item-' || i, CASE WHEN i=1 THEN 'user' ELSE 'assistant' END,
                       CASE WHEN i=1 THEN 'user_message' WHEN i>=17327 THEN 'assistant_message'
                            ELSE 'progress' END,
                       jsonb_build_object('parts', jsonb_build_array(
                           jsonb_build_object('text', CASE WHEN i=17327 THEN repeat('全文',100000) || 'BODY_END'
                                ELSE 'browser-marker-' || i END))), i, i, 'one-run'
                FROM generate_series(1,17328) i
            """, service.namespace, session_id)
        app = create_runtime_app(RuntimeAppConfig(
            route_groups={"sessions"}, session_service_provider=lambda: service,
        ), configure_runtime_app)
        await uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=18087)).serve()
    finally:
        await service.delete_session(session_id)
        await service.aclose()


if __name__ == "__main__":
    asyncio.run(main())
