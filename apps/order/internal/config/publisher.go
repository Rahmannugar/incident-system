package config

import (
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"strings"
)

type Publisher struct{ DatabaseURL, BaseURL, Token, Destination string }

func publisherOrigin(raw string, localOnly, allowDocker bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("invalid QStash origin")
	}
	loopback := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	if localOnly {
		if u.Scheme != "http" || !loopback {
			return "", errors.New("local QStash must use loopback HTTP")
		}
	} else if u.Scheme != "https" && !(u.Scheme == "http" && (loopback || allowDocker && u.Hostname() == "host.docker.internal")) {
		return "", errors.New("QStash origin must use HTTPS or an allowed development host")
	}
	return strings.TrimRight(u.String(), "/"), nil
}
func LoadPublisher() (Publisher, error) {
	var c Publisher
	var err error
	mode := value("INCIDENT_SYSTEM_QSTASH_MODE", "hosted")
	if mode != "local" && mode != "hosted" {
		return c, errors.New("INCIDENT_SYSTEM_QSTASH_MODE must be local or hosted")
	}
	if mode == "local" {
		c.BaseURL, err = publisherOrigin(value("INCIDENT_SYSTEM_QSTASH_LOCAL_URL", "http://127.0.0.1:8081"), true, false)
		c.Token = base64.StdEncoding.EncodeToString([]byte(`{"UserID":"defaultUser","Password":"defaultPassword"}`))
	} else {
		c.BaseURL, err = publisherOrigin(value("INCIDENT_SYSTEM_QSTASH_URL", "https://qstash.upstash.io"), false, false)
		c.Token = os.Getenv("INCIDENT_SYSTEM_QSTASH_TOKEN")
	}
	if err != nil {
		return c, err
	}
	if c.Token == "" {
		return c, errors.New("INCIDENT_SYSTEM_QSTASH_TOKEN is required")
	}
	origin, err := publisherOrigin(os.Getenv("INCIDENT_SYSTEM_NOTIFICATION_CALLBACK_BASE_URL"), false, mode == "local")
	if err != nil {
		return c, errors.New("INCIDENT_SYSTEM_NOTIFICATION_CALLBACK_BASE_URL must be a valid callback origin")
	}
	c.Destination = origin + "/events/order"
	c.DatabaseURL, err = DatabaseURL()
	return c, err
}
