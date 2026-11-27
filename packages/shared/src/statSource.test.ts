import { describe, expect, it } from 'vitest';
import { healthAppName } from './statSource.js';

describe('healthAppName', () => {
  it('names the phone itself and the sleep app', () => {
    expect(healthAppName('com.android.healthconnect.phone.4f2a9c')).toBe('This phone');
    expect(healthAppName('com.android.healthconnect.phone')).toBe('This phone');
    expect(healthAppName('com.urbandroid.sleep')).toBe('Sleep as Android');
  });
  it('prefers our wording, then the name the phone looked up, then the package', () => {
    expect(healthAppName('com.fitbit.FitbitMobile', 'Fitbit app')).toBe('Fitbit');
    expect(healthAppName('com.randallengineering.sleepasringconn', ' Ring connector ')).toBe(
      'Ring connector',
    );
    expect(healthAppName('com.example.unknown')).toBe('com.example.unknown');
  });
});
