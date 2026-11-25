package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Rahmannugar/incident-system/apps/order/internal/config"
	"github.com/Rahmannugar/incident-system/apps/order/internal/orders"
	identityv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/identity/v1"
	orderv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/order/v1"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("invalid Order database settings")
	}
	poolConfig.MaxConns = 5
	poolConfig.ConnConfig.ConnectTimeout = 2 * time.Second
	poolConfig.ConnConfig.RuntimeParams["statement_timeout"] = "2000"
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return errors.New("initialize Order database")
	}
	defer pool.Close()
	repository := orders.NewRepository(pool)
	startup, cancel := context.WithTimeout(ctx, 3*time.Second)
	err = repository.CheckSchema(startup)
	cancel()
	if err != nil {
		return errors.New("Order database schema is unavailable")
	}
	connection, err := grpc.NewClient(cfg.IdentityAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return errors.New("initialize Identity client")
	}
	defer connection.Close()
	implementation := orders.NewServer(orders.NewService(repository), identityv1.NewIdentityServiceClient(connection), cfg.RPCTimeout, logger)
	server := grpc.NewServer(grpc.UnaryInterceptor(implementation.Intercept), grpc.MaxRecvMsgSize(4096), grpc.MaxHeaderListSize(8192), grpc.MaxConcurrentStreams(64))
	orderv1.RegisterOrderServiceServer(server, implementation)
	listener, err := net.Listen("tcp", cfg.Address)
	if err != nil {
		return errors.New("bind Order listener")
	}
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()
	logger.Info("order.started", "service", "order", "address", listener.Addr().String())
	select {
	case err := <-stopped:
		if err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			return errors.New("Order listener failed")
		}
		return nil
	case <-ctx.Done():
	}
	done := make(chan struct{})
	go func() { server.GracefulStop(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		server.Stop()
		<-done
	}
	logger.Info("order.stopped", "service", "order")
	return nil
}
func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("order.failed", "service", "order", "reason", err.Error())
		os.Exit(1)
	}
}
