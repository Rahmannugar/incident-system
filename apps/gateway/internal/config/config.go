package config

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"time"
)

type Config struct {
	HTTPAddress     string
	IdentityAddress string
	RPCTimeout      time.Duration
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func Load() (Config, error) {
	c := Config{HTTPAddress: env("INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS", "127.0.0.1:8080"), IdentityAddress: env("INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS", "127.0.0.1:50051")}
	for name, address := range map[string]string{"INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS": c.HTTPAddress, "INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS": c.IdentityAddress} {
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
