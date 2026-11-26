package gateway

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestDeliveryAuthentication(t *testing.T) {
	body := []byte(`{"id":"example"}`)
	hash := sha256.Sum256(body)
	config := EventConfig{Destination: "https://callback.example.test/events/payment", SigningKeys: [2]string{"current-fixture-key", "next-fixture-key"}}
	now := time.Now()
	base := deliveryClaims{RegisteredClaims: jwt.RegisteredClaims{Issuer: "Upstash", Subject: config.Destination, NotBefore: jwt.NewNumericDate(now.Add(-time.Second)), ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute))}, Body: base64.RawURLEncoding.EncodeToString(hash[:])}
	for _, key := range config.SigningKeys {
		signature, err := jwt.NewWithClaims(jwt.SigningMethodHS256, base).SignedString([]byte(key))
		if err != nil {
			t.Fatal(err)
		}
		if !verifyDelivery(signature, body, config) {
			t.Fatal("current/next signing keys must both verify")
		}
	}
	cases := []struct {
		name      string
		modify    func(*deliveryClaims)
		algorithm jwt.SigningMethod
	}{
		{"wrong destination", func(c *deliveryClaims) { c.Subject = "https://callback.example.test/other" }, jwt.SigningMethodHS256},
		{"wrong issuer", func(c *deliveryClaims) { c.Issuer = "other" }, jwt.SigningMethodHS256},
		{"missing expiry", func(c *deliveryClaims) { c.ExpiresAt = nil }, jwt.SigningMethodHS256},
		{"missing not-before", func(c *deliveryClaims) { c.NotBefore = nil }, jwt.SigningMethodHS256},
		{"expired", func(c *deliveryClaims) { c.ExpiresAt = jwt.NewNumericDate(now.Add(-time.Second)) }, jwt.SigningMethodHS256},
		{"future validity", func(c *deliveryClaims) { c.NotBefore = jwt.NewNumericDate(now.Add(time.Minute)) }, jwt.SigningMethodHS256},
		{"wrong body", func(c *deliveryClaims) { c.Body = "different" }, jwt.SigningMethodHS256},
		{"wrong algorithm", func(*deliveryClaims) {}, jwt.SigningMethodHS384},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			claims := base
			test.modify(&claims)
			signature, err := jwt.NewWithClaims(test.algorithm, claims).SignedString([]byte(config.SigningKeys[0]))
			if err != nil {
				t.Fatal(err)
			}
			if verifyDelivery(signature, body, config) {
				t.Fatal("invalid delivery accepted")
			}
		})
	}
}
