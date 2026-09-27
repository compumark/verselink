package main

import (
	"context"
	"sync"
)

type pairingPostGate struct {
	mu      sync.Mutex
	stopped bool
}

func (g *pairingPostGate) active() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return !g.stopped
}

func (g *pairingPostGate) postIfActive(post func()) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopped {
		return false
	}
	post()
	return true
}

func (g *pairingPostGate) stop() {
	g.mu.Lock()
	g.stopped = true
	g.mu.Unlock()
}

func stopPairingWorker(cancel context.CancelFunc, done <-chan struct{}, drain func()) {
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	if drain != nil {
		drain()
	}
}

// shutdownPairing is the single non-UI shutdown path used after both a normal
// Exit request and an unexpected message-loop failure.  The result handler
// runs only after the worker has stopped, so a successful claim already in the
// buffered result channel can persist its credential without posting to a
// window that may no longer exist.
func shutdownPairing(gate *pairingPostGate, cancel context.CancelFunc, done <-chan struct{}, handle func()) {
	if gate != nil {
		gate.stop()
	}
	stopPairingWorker(cancel, done, handle)
}
