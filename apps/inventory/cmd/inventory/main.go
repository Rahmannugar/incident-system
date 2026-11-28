package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Rahmannugar/incident-system/apps/inventory/internal/config"
	"github.com/Rahmannugar/incident-system/apps/inventory/internal/inventory"
	inventoryv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/inventory/v1"
	"github.com/Rahmannugar/incident-system/packages/telemetry"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
)

func run(logger *slog.Logger) error {
	shutdown, telemetryErr := telemetry.Init("inventory", logger)
	if telemetryErr != nil {
		return telemetryErr
	}
	defer shutdown()
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	client := redis.NewClient(cfg.Redis)
	defer client.Close()
	store := inventory.NewStore(client, cfg.Prefix, cfg.HoldTTL)
	if len(os.Args) > 1 {
		op := os.Args[1]
		if op != "seed" && op != "reset" {
			return errors.New("expected seed or reset command")
		}
		flags := flag.NewFlagSet(op, flag.ContinueOnError)
		sku := flags.String("sku", "demo-item", "Inventory SKU")
		stock := flags.Int("stock", 10, "Unsold stock quantity")
		remove := flags.Bool("remove", false, "Remove the SKU during reset")
		if err := flags.Parse(os.Args[2:]); err != nil {
			return err
		}
		if *stock < 0 || *stock > 1000000 {
			return errors.New("stock must be between 0 and 1000000")
		}
		ctx, cancel := context.WithTimeout(context.Background(), cfg.RPCTimeout)
		defer cancel()
		if *remove {
			if op != "reset" {
				return errors.New("remove is only valid during reset")
			}
			op = "remove"
		}
		result, err := store.Execute(ctx, op, *sku, "", 0, int32(*stock))
		if err != nil {
			return errors.New("Inventory stock command failed")
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, cfg.RPCTimeout)
	err = store.Health(startup)
	cancel()
	if err != nil {
		return errors.New("Inventory Redis is unavailable")
	}
	implementation := inventory.NewServer(store, cfg.ServiceToken, cfg.RPCTimeout, logger)
	server := grpc.NewServer(grpc.ChainUnaryInterceptor(telemetry.ServerInterceptor, implementation.Intercept), grpc.MaxRecvMsgSize(4096), grpc.MaxHeaderListSize(8192), grpc.MaxConcurrentStreams(64))
	inventoryv1.RegisterInventoryServiceServer(server, implementation)
	listener, err := net.Listen("tcp", cfg.Address)
	if err != nil {
		return errors.New("bind Inventory listener")
	}
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()
	logger.Info("inventory.started", "service", "inventory", "address", listener.Addr().String())
	select {
	case err := <-stopped:
		if err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			return errors.New("Inventory listener failed")
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
	logger.Info("inventory.stopped", "service", "inventory")
	return nil
}
func main() {
	logger := slog.New(telemetry.Handler{Inner: slog.NewJSONHandler(os.Stdout, nil)})
	if err := run(logger); err != nil {
		logger.Error("inventory.failed", "service", "inventory", "reason", err.Error())
		os.Exit(1)
	}
}
