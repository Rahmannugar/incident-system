package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Rahmannugar/incident-system/apps/gateway/internal/config"
	"github.com/Rahmannugar/incident-system/apps/gateway/internal/gateway"
	identityv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	connection, err := grpc.NewClient(cfg.IdentityAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return errors.New("initialize identity client")
	}
	defer connection.Close()
	listener, err := net.Listen("tcp", cfg.HTTPAddress)
	if err != nil {
		return errors.New("bind gateway listener")
	}
	server := &http.Server{Handler: gateway.New(identityv1.NewIdentityServiceClient(connection), cfg.RPCTimeout, logger), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192}
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()
	logger.Info("gateway.started", "service", "gateway", "address", listener.Addr().String())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-stopped:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("gateway listener failed")
		}
		return nil
	case <-ctx.Done():
	}
	drain, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(drain); err != nil {
		_ = server.Close()
		return errors.New("gateway shutdown timed out")
	}
	logger.Info("gateway.stopped", "service", "gateway")
	return nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("gateway.failed", "service", "gateway", "reason", err.Error())
		os.Exit(1)
	}
}
