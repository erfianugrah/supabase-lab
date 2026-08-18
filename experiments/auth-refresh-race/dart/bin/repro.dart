// Repro for the concurrent-refresh / stale-refresh-token defect in gotrue
// (supabase_flutter issues 895/930, fixed by PR 1351 in gotrue v2.22.0).
//
// Scenario `stale-reuse` (the deterministic differential):
//   1. sign in with password -> session S0 (refresh token rt0)
//   2. refresh -> S1 (rt1); rt0 is now rotated out
//   3. wait out the server-side reuse interval (GoTrue default 10s), then
//      present the STALE rt0 - exactly what a resumed app holding an old
//      persisted session does
//   4. pre-fix client: refresh_token_already_used -> _removeSession() +
//      signedOut, even though S1 is valid for another hour. post-fix client:
//      keeps S1, no signedOut event.
//
// Scenario `concurrent-same`:
//   fire N concurrent refreshSession() calls on one token; record outcomes,
//   auth events, and whether the session survives.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD.
// Args: scenario name, optional reuse-window seconds (default 12).

import 'dart:async';
import 'dart:io';

import 'package:gotrue/gotrue.dart';

String envOrDie(String name) {
  final v = Platform.environment[name];
  if (v == null || v.isEmpty) {
    stderr.writeln('missing env $name');
    exit(2);
  }
  return v;
}

Future<void> main(List<String> args) async {
  final scenario = args.isEmpty ? 'stale-reuse' : args[0];
  final reuseWindowSec = args.length > 1 ? int.parse(args[1]) : 12;

  final url = envOrDie('SUPABASE_URL');
  final anonKey = envOrDie('SUPABASE_ANON_KEY');
  final email = envOrDie('TEST_EMAIL');
  final password = envOrDie('TEST_PASSWORD');

  final events = <String>[];
  final client = GoTrueClient(
    url: '$url/auth/v1',
    headers: {'apikey': anonKey, 'Authorization': 'Bearer $anonKey'},
    autoRefreshToken: false,
  );
  client.onAuthStateChange.listen((s) => events.add(s.event.name));

  final signIn = await client.signInWithPassword(
    email: email,
    password: password,
  );
  final s0 = signIn.session!;
  final rt0 = s0.refreshToken!;
  print('signed in: expiresIn=${s0.expiresIn}s rt0=${rt0.substring(0, 8)}...');

  switch (scenario) {
    case 'stale-reuse':
      // Rotate twice: rt0 -> rt1 -> rt2. GoTrue tolerates reuse of the
      // direct PARENT of the active token without any time limit (the
      // "client could not store the result" branch in token_service.go), so
      // the racing-path case that actually errors is a token two or more
      // generations stale - e.g. a custom LocalStorage that resurrected rt0
      // while the live session already moved on to rt2.
      final r1 = await client.refreshSession(rt0);
      final rt1 = r1.session!.refreshToken!;
      final r2 = await client.refreshSession(rt1);
      print('rotated: rt1=${rt1.substring(0, 8)}... '
          'rt2=${r2.session!.refreshToken!.substring(0, 8)}...');
      print('session valid after rotation: '
          '${client.currentSession != null}');

      // Let the server-side reuse interval lapse so the stale token is a
      // hard rejection, not a tolerated reuse.
      print('waiting ${reuseWindowSec}s for the reuse window to lapse...');
      await Future.delayed(Duration(seconds: reuseWindowSec));

      // The resumed-app path: present the stale token.
      Object? error;
      try {
        await client.refreshSession(rt0);
        print('stale refresh: returned without throwing');
      } catch (e) {
        error = e;
        final code = e is AuthApiException ? e.code : null;
        print('stale refresh threw: ${e.runtimeType}'
            '${code != null ? ' code=$code' : ''}');
      }

      final survived = client.currentSession != null;
      // Auth events travel a broadcast stream; give delivery a beat before
      // reading the event list.
      await Future.delayed(const Duration(milliseconds: 500));
      print('---RESULT---');
      print('error_code=${error is AuthApiException ? error.code : '-'}');
      print('session_survived=$survived');
      print('signed_out_emitted=${events.contains('signedOut')}');
      print('events=${events.join(',')}');
      // The defect: server rejected a stale token, but the client punished
      // the VALID current session for it. The fix (PR 1351, gotrue v2.22.0)
      // absorbs refresh_token_already_used when the current session is still
      // valid and returns that session - so on a fixed client the call
      // returns WITHOUT throwing. The grandparent-token server rejection
      // itself was verified out-of-band with curl (see RUNLOG).
      if (error != null && !survived) {
        print('VERDICT=defect-reproduced (valid session destroyed by a '
            'stale-token race)');
      } else if (error == null && survived) {
        print('VERDICT=fixed (stale-token rejection absorbed, valid session '
            'returned)');
      } else if (error != null && survived) {
        print('VERDICT=partial (error surfaced but session kept)');
      } else {
        print('VERDICT=unexpected (no error, no session)');
      }

    case 'concurrent-same':
      const n = 5;
      final results = await Future.wait([
        for (var i = 0; i < n; i++)
          client
              .refreshSession(rt0)
              .then((r) => 'ok:${r.session?.accessToken.substring(0, 8)}')
              .catchError((Object e) => 'err:${e.runtimeType}'),
      ]);
      print('---RESULT---');
      for (var i = 0; i < n; i++) {
        print('call[$i]=${results[i]}');
      }
      print('session_survived=${client.currentSession != null}');
      print('events=${events.join(',')}');

    default:
      stderr.writeln('unknown scenario $scenario');
      exit(2);
  }

  client.dispose();
}
