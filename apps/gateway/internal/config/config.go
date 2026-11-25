package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"
)

type Config struct {
	HTTPAddress      string
	IdentityAddress  string
	OrderAddress     string
	PaymentAddress   string
	InventoryAddress string
	InventoryToken   string
	RPCTimeout       time.Duration
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func Load() (Config, error) {
	c := Config{PaymentAddress: env("INCIDENT_SYSTEM_GATEWAY_PAYMENT_ADDRESS", "127.0.0.1:50054"), InventoryAddress: env("INCIDENT_SYSTEM_GATEWAY_INVENTORY_ADDRESS", "127.0.0.1:50053"), InventoryToken: os.Getenv("INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN"), HTTPAddress: env("INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS", "127.0.0.1:8080"), OrderAddress: env("INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS", "127.0.0.1:50052"), IdentityAddress: env("INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS", "127.0.0.1:50051")}
	if len(c.InventoryToken) < 32 {
		return c, errors.New("INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN must contain at least 32 characters")
	}
	for name, address := range map[string]string{"INCIDENT_SYSTEM_GATEWAY_PAYMENT_ADDRESS": c.PaymentAddress, "INCIDENT_SYSTEM_GATEWAY_INVENTORY_ADDRESS": c.InventoryAddress, "INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS": c.OrderAddress, "INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS": c.HTTPAddress, "INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS": c.IdentityAddress} {
		_, port, err := net.SplitHostPort(address)
		n, parseErr := strconv.Atoi(port)
		if err != nil || parseErr != nil || n < 0 || n > 65535 {
			return c, fmt.Errorf("%s must contain a host and valid port", name)
		}
	}
	var err error
	c.RPCTimeout, err = time.ParseDuration(env("INCIDENT_SYSTEM_GATEWAY_RPC_TIMEOUT", "3s"))
	if err != nil || c.RPCTimeout < time.Millisecond || c.RPCTimeout > 30*time.Second {
		return c, fmt.Errorf("INCIDENT_SYSTEM_GATEWAY_RPC_TIMEOUT must be between 1ms and 30s")
	}
	return c, nil
}
