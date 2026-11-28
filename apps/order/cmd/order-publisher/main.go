package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Rahmannugar/incident-system/apps/order/internal/config"
	"github.com/Rahmannugar/incident-system/apps/order/internal/orders"
	"github.com/Rahmannugar/incident-system/packages/telemetry"
	"github.com/jackc/pgx/v5/pgxpool"
)

func run(logger *slog.Logger) error {
	shutdown, telemetryErr := telemetry.Init("order", logger)
	if telemetryErr != nil {
		return telemetryErr
	}
	// Keep telemetry collection alive until the last owned outbox snapshot is
	// exported, and close the pool afterward.
	var publisherPool *pgxpool.Pool
	defer func() {
		shutdown()
		if publisherPool != nil {
			publisherPool.Close()
		}
	}()
	cfg, err := config.LoadPublisher()
	if err != nil {
		return err
	}
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("invalid Order database configuration")
	}
	poolConfig.MaxConns = 3
	poolConfig.ConnConfig.ConnectTimeout = 2 * time.Second
	poolConfig.ConnConfig.RuntimeParams["statement_timeout"] = "2000"
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return errors.New("initialize Order publisher database")
	}
	publisherPool = pool
	return orders.NewOutboxPublisher(pool, cfg.BaseURL, cfg.Token, cfg.Destination, logger).Run(ctx)
}
func main() {
	logger := slog.New(telemetry.Handler{Inner: slog.NewJSONHandler(os.Stdout, nil)})
	if err := run(logger); err != nil {
		logger.Error("outbox.start_failed", "service", "order", "reason", err.Error())
		os.Exit(1)
	}
}
