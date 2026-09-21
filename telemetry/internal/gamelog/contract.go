package gamelog

// FixtureCase identifies one sanitized Game.log example. A2 describes the
// contract only; it does not parse the fixture input.
type FixtureCase struct {
	Path        string
	ShouldMatch bool
}

// EventContract is the data-oriented contract later parser issues implement.
type EventContract struct {
	Name             string
	Presence         bool
	Phase            string
	ExpectedFields   []string
	Positive         FixtureCase
	Negative         []FixtureCase
	RequiresMultiple bool
	Notes            string
}

// ApprovedEventContracts returns the Milestone-A event and reference
// contracts. Paths are relative to telemetry/testdata/events.
func ApprovedEventContracts() []EventContract {
	return []EventContract{
		{Name: "player_login", Presence: true, Phase: "P0", ExpectedFields: []string{"handle", "geid"}, Positive: FixtureCase{"session/player_login.valid.log", true}, Negative: []FixtureCase{{"session/player_login.invalid.log", false}}},
		{Name: "server_joined", Presence: true, Phase: "P0", ExpectedFields: []string{"shard"}, Positive: FixtureCase{"session/server_joined.valid.log", true}, Negative: []FixtureCase{{"session/server_joined.invalid.log", false}}},
		{Name: "player_spawned", Presence: true, Phase: "P0", Positive: FixtureCase{"session/player_spawned.valid.log", true}, Negative: []FixtureCase{{"session/player_spawned.invalid.log", false}}},
		{Name: "location_change", Presence: true, Phase: "P0", ExpectedFields: []string{"player", "location"}, Positive: FixtureCase{"location/location_change.valid.log", true}, Negative: []FixtureCase{{"location/location_change.invalid.log", false}}, Notes: "Last observed location, not GPS or XYZ."},
		{Name: "jurisdiction_entered", Presence: true, Phase: "P0", ExpectedFields: []string{"jurisdiction"}, Positive: FixtureCase{"location/jurisdiction_entered.valid.log", true}, Negative: []FixtureCase{{"location/jurisdiction_entered.invalid.log", false}}},
		{Name: "ship_boarded", Presence: true, Phase: "P0", ExpectedFields: []string{"ship", "owner", "raw"}, Positive: FixtureCase{"ships/ship_boarded.valid.log", true}, Negative: []FixtureCase{{"ships/ship_boarded.invalid.log", false}}, Notes: "Normalize @vehicle_Name for ship and preserve raw."},
		{Name: "ship_exited", Presence: true, Phase: "P0", ExpectedFields: []string{"ship", "owner", "raw"}, Positive: FixtureCase{"ships/ship_exited.valid.log", true}, Negative: []FixtureCase{{"ships/ship_exited.invalid.log", false}}, Notes: "Normalize @vehicle_Name for ship and preserve raw."},
		{Name: "qt_target_selected", Presence: true, Phase: "P0", ExpectedFields: []string{"destination"}, Positive: FixtureCase{"quantum/qt_target_selected.valid.log", true}, Negative: []FixtureCase{{"quantum/qt_target_selected.invalid.log", false}}},
		{Name: "qt_fuel_requested", Presence: true, Phase: "P0", ExpectedFields: []string{"destination"}, Positive: FixtureCase{"quantum/qt_fuel_requested.valid.log", true}, Negative: []FixtureCase{{"quantum/qt_fuel_requested.invalid.log", false}}},
		{Name: "qt_arrived", Presence: true, Phase: "P0", Positive: FixtureCase{"quantum/qt_arrived.valid.log", true}, Negative: []FixtureCase{{"quantum/qt_arrived.invalid.log", false}}, Notes: "No destination; never infer one from this event alone."},
		{Name: "party_member_joined", Presence: true, Phase: "P0", ExpectedFields: []string{"player"}, Positive: FixtureCase{"party/party_member_joined.valid.log", true}, Negative: []FixtureCase{{"party/party_member_joined.invalid.log", false}, {"party/party_member_joined.stale.log", false}, {"party/party_member_joined.wrong-continuation.log", false}}, RequiresMultiple: true, Notes: "Header creates pending state; continuation emits and clears it."},
		{Name: "party_member_left", Presence: true, Phase: "P0", ExpectedFields: []string{"player"}, Positive: FixtureCase{"party/party_member_left.valid.log", true}, Negative: []FixtureCase{{"party/party_member_left.invalid.log", false}, {"party/party_member_left.stale.log", false}, {"party/party_member_left.wrong-continuation.log", false}}, RequiresMultiple: true, Notes: "Header creates pending state; continuation emits and clears it."},
		{Name: "party_disbanded", Presence: true, Phase: "P0", Positive: FixtureCase{"party/party_disbanded.valid.log", true}, Negative: []FixtureCase{{"party/party_disbanded.invalid.log", false}}},
		{Name: "blueprint_received", Presence: false, Phase: "P1", ExpectedFields: []string{"name"}, Positive: FixtureCase{"reference/blueprint_received.valid.log", true}, Negative: []FixtureCase{{"reference/blueprint_received.invalid.log", false}}, Notes: "Reference-only; not a presence event."},
		{Name: "refinery_complete", Presence: false, Phase: "P1", ExpectedFields: []string{"location"}, Positive: FixtureCase{"reference/refinery_complete.valid.log", true}, Negative: []FixtureCase{{"reference/refinery_complete.invalid.log", false}}, Notes: "Reference-only; not a presence event."},
	}
}
