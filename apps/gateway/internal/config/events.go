package config

import (
	"errors"
	"net/url"
	"os"
	"strings"
)

func (c *Config) loadEvents() error {
	c.OrderToken = os.Getenv("INCIDENT_SYSTEM_ORDER_SERVICE_TOKEN")
	c.PaymentToken = os.Getenv("INCIDENT_SYSTEM_PAYMENT_SERVICE_TOKEN")
	if len(c.OrderToken) < 32 || len(c.PaymentToken) < 32 {
		return errors.New("Order and Payment service tokens must contain at least 32 characters")
	}
	mode := env("INCIDENT_SYSTEM_QSTASH_MODE", "hosted")
	if mode != "local" && mode != "hosted" {
		return errors.New("INCIDENT_SYSTEM_QSTASH_MODE must be local or hosted")
	}
	origin := os.Getenv("INCIDENT_SYSTEM_CALLBACK_BASE_URL")
	if origin == "" {
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("INCIDENT_SYSTEM_CALLBACK_BASE_URL must be an origin")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && (local || mode == "local" && u.Hostname() == "host.docker.internal")) {
		return errors.New("callback origin must use HTTPS or an allowed local development host")
	}
	c.PaymentCallbackURL = strings.TrimRight(u.String(), "/") + "/events/payment"
	if mode == "local" {
		// Public fixtures of the official development server, not hosted secrets.
		c.SigningKeys = [2]string{"sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r", "sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs"}
	} else {
		c.SigningKeys = [2]string{os.Getenv("INCIDENT_SYSTEM_QSTASH_CURRENT_SIGNING_KEY"), os.Getenv("INCIDENT_SYSTEM_QSTASH_NEXT_SIGNING_KEY")}
		if c.SigningKeys[0] == "" || c.SigningKeys[1] == "" {
			return errors.New("QStash current and next signing keys are required")
		}
	}
	return nil
}
