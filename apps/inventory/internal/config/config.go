package config

import (
	"errors"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type Config struct {
	Redis        *redis.Options
	Address      string
	ServiceToken string
	Prefix       string
	HoldTTL      time.Duration
	RPCTimeout   time.Duration
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func Load() (Config, error) {
	c := Config{Address: env("INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS", "127.0.0.1:50053"), ServiceToken: os.Getenv("INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN"), Prefix: env("INCIDENT_SYSTEM_INVENTORY_REDIS_PREFIX", "incident-system:inventory:")}
	if len(c.ServiceToken) < 32 {
		return c, errors.New("INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN must contain at least 32 characters")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9:_-]{1,96}:$`).MatchString(c.Prefix) {
		return c, errors.New("INCIDENT_SYSTEM_INVENTORY_REDIS_PREFIX must be a colon-terminated namespace")
	}
	host, port, err := net.SplitHostPort(c.Address)
	n, parseErr := strconv.Atoi(port)
	if err != nil || parseErr != nil || n < 0 || n > 65535 || (host != "127.0.0.1" && host != "::1" && host != "localhost") {
		return c, errors.New("INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS must use a loopback host and valid port")
	}
	raw := os.Getenv("INCIDENT_SYSTEM_INVENTORY_REDIS_URL")
	if !strings.HasPrefix(raw, "rediss://") {
		return c, errors.New("INCIDENT_SYSTEM_INVENTORY_REDIS_URL must use rediss TLS")
	}
	c.Redis, err = redis.ParseURL(raw)
	if err != nil {
		return c, errors.New("invalid Inventory Redis connection settings")
	}
	if c.Redis.TLSConfig.InsecureSkipVerify {
		return c, errors.New("Inventory Redis certificate verification must remain enabled")
	}
	c.Redis.DialTimeout = 2 * time.Second
	c.Redis.ReadTimeout = 2 * time.Second
	c.Redis.WriteTimeout = 2 * time.Second
	c.Redis.ContextTimeoutEnabled = true
	c.Redis.MaxRetries = -1
	c.Redis.PoolSize = 8
	c.Redis.Protocol = 2
	c.Redis.DisableIdentity = true
	c.HoldTTL, err = time.ParseDuration(env("INCIDENT_SYSTEM_INVENTORY_HOLD_TTL", "15m"))
	if err != nil || c.HoldTTL < time.Second || c.HoldTTL > time.Hour {
		return c, errors.New("INCIDENT_SYSTEM_INVENTORY_HOLD_TTL must be between 1s and 1h")
	}
	c.RPCTimeout, err = time.ParseDuration(env("INCIDENT_SYSTEM_INVENTORY_RPC_TIMEOUT", "3s"))
	if err != nil || c.RPCTimeout < time.Millisecond || c.RPCTimeout > 30*time.Second {
		return c, errors.New("INCIDENT_SYSTEM_INVENTORY_RPC_TIMEOUT must be between 1ms and 30s")
	}
	return c, nil
}
