module github.com/Rahmannugar/incident-system/apps/inventory

go 1.27.3

require (
	github.com/Rahmannugar/incident-system/packages/contracts v0.0.0
	github.com/google/uuid v1.6.0
	github.com/redis/go-redis/v9 v9.22.0
	google.golang.org/grpc v1.85.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/klauspost/cpuid/v2 v2.4.0 // indirect
	github.com/stretchr/testify v1.12.1 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260817212433-ac3dfec99bb1 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

replace github.com/Rahmannugar/incident-system/packages/contracts => ../../packages/contracts
