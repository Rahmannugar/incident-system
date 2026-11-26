package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"time"
)

type Config struct {
	ServiceToken    string
	DatabaseURL     string
	Address         string
	IdentityAddress string
	RPCTimeout      time.Duration
}

func value(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func Load() (Config, error) {
	c := Config{Address: value("INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS", "127.0.0.1:50052"), IdentityAddress: value("INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS", "127.0.0.1:50051")}
	c.ServiceToken = os.Getenv("INCIDENT_SYSTEM_ORDER_SERVICE_TOKEN")
	if len(c.ServiceToken) < 32 {
		return c, fmt.Errorf("INCIDENT_SYSTEM_ORDER_SERVICE_TOKEN must contain at least 32 characters")
	}
	password := os.Getenv("INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD")
	if password == "" {
		return c, fmt.Errorf("INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD is required")
	}
	rawPort := value("INCIDENT_SYSTEM_DATABASE_PORT", "55432")
	port, err := strconv.Atoi(rawPort)
	if err != nil || port < 1 || port > 65535 {
		return c, fmt.Errorf("INCIDENT_SYSTEM_DATABASE_PORT must be between 1 and 65535")
	}
	mode := value("INCIDENT_SYSTEM_DATABASE_SSL_MODE", "disable")
	if mode != "disable" && mode != "require" {
		return c, fmt.Errorf("INCIDENT_SYSTEM_DATABASE_SSL_MODE must be disable or require")
	}
	u := &url.URL{Scheme: "postgres", Host: net.JoinHostPort(value("INCIDENT_SYSTEM_DATABASE_HOST", "127.0.0.1"), strconv.Itoa(port)), Path: "/" + value("INCIDENT_SYSTEM_ORDER_DATABASE_NAME", "incident_system_order"), User: url.UserPassword(value("INCIDENT_SYSTEM_ORDER_DATABASE_USER", "incident_system_order"), password)}
	query := u.Query()
	query.Set("sslmode", mode)
	u.RawQuery = query.Encode()
	c.DatabaseURL = u.String()
	for name, address := range map[string]string{"INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS": c.Address, "INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS": c.IdentityAddress} {
		_, p, e := net.SplitHostPort(address)
		n, pe := strconv.Atoi(p)
		if e != nil || pe != nil || n < 0 || n > 65535 {
			return c, fmt.Errorf("%s must contain a host and valid port", name)
		}
	}
	c.RPCTimeout, err = time.ParseDuration(value("INCIDENT_SYSTEM_ORDER_RPC_TIMEOUT", "3s"))
	if err != nil || c.RPCTimeout < time.Millisecond || c.RPCTimeout > 30*time.Second {
		return c, fmt.Errorf("INCIDENT_SYSTEM_ORDER_RPC_TIMEOUT must be between 1ms and 30s")
	}
	return c, nil
}
