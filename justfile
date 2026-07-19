default:
    @just --list

# Start the dev server (http://127.0.0.1:3141)
dev:
    bun run dev

# Start local MongoDB (returns only once healthy)
db-up:
    docker compose up -d --wait

# Stop local MongoDB
db-down:
    docker compose down

# Run the test suite
test:
    bun run test

# Typecheck without emitting
typecheck:
    bun run typecheck
